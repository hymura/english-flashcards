    // ╔══════════════════════════════════════════════════════════╗
    // ║  CONFIGURACIÓN SUPABASE                                   ║
    // ╚══════════════════════════════════════════════════════════╝
    const SUPABASE_URL = 'https://amdgbcrphpbdugsdsaqh.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_Uxfxt2hwHdjEz0OH_9oicQ_Es-CU7VI';
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    let phrases = [];
    let current = 0;
    let seen    = new Set();
    let activeCategory = 'all';
    let activeConcept = null;     // cid U8 si el user filtra por concepto; null = sin filtro Core
    let allPhrases = [];          // caché completa traída de Supabase
    let currentUser = null;       // usuario autenticado (o null = invitado)
    let progressMap = new Map();  // phrase_id -> { status, best_score, attempts }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  LEARNING CORE · dual-write (DESACTIVADO por defecto)     ║
    // ╚══════════════════════════════════════════════════════════╝
    // Kill switch nivel 1: con LC.enabled=false el Core no se toca y la app
    // funciona EXACTAMENTE igual que hoy. El dual-write es best-effort: va
    // detrás del flag, envuelto en try/catch, y nunca bloquea el flujo del quiz.
    // Flip a true SOLO cuando el esquema del Learning Core esté migrado (Fase 1).
    // Allowlist Fase 2 (fail-closed): SOLO estos UUID (= currentUser.id / auth.uid())
    // activan el Core. Vacía = nadie. Cualquier otro usuario: OFF. Temporal para la
    // prueba controlada; en go-live se sustituye por activación global.
    const LC_ALLOW = [
      'eb4f49c3-bf27-4199-8650-e0e68da95d01',   // (Alex) cuenta de prueba — única habilitada
    ];
    // Producción general: true = Core ON para TODO usuario autenticado (fail-closed).
    // false = solo LC_ALLOW (canary/rollback). Único interruptor de expansión.
    const LC_GLOBAL = true;
    const LC = {
      // _force: false = kill switch total (OFF siempre). Por defecto null: manda la
      // allowlist. NO existe forzar-ON: la única vía de ON es estar en LC_ALLOW (fail-closed).
      _force: null,
      get enabled() {
        if (this._force === false) return false;                             // kill switch total
        if (!currentUser || !currentUser.id) return false;                   // no autenticado
        if (LC_GLOBAL) return true;                                          // producción general (solo autenticados llegan aquí)
        if (!Array.isArray(LC_ALLOW) || LC_ALLOW.length === 0) return false;  // allowlist vacía/ausente
        return LC_ALLOW.includes(currentUser.id);                            // ON solo si incluido
      },
      async submitAttempt(exerciseId, opts = {}) {
        if (!this.enabled || !currentUser || exerciseId == null) return;
        const { response = null, isCorrect = null, score = null,
                errorType = null, latencyMs = null, evidence = null } = opts;
        const { error } = await sb.rpc('rpc_lc_submit_attempt', {
          p_exercise_id: exerciseId, p_response: response, p_is_correct: isCorrect,
          p_score: score, p_error_type: errorType, p_latency_ms: latencyMs, p_evidence: evidence
        });
        if (error) console.warn('LC.submitAttempt:', error.message);
      },
      // ── Fase 2 · evidence-only explícito ──────────────────────────
      // NO usa rpc_lc_submit_attempt con exercise_id=null. Requiere items ya
      // resueltos = [{conceptId, skillId, outcome}]. Sin items válidos → no-op.
      // Escribe vía rpc_lc_record_evidence (RPC nueva; su SQL está pendiente de aprobación).
      async recordEvidence(items) {
        if (!this.enabled || !currentUser) return;
        if (!Array.isArray(items) || items.length === 0) return;
        const payload = items
          .filter(i => i && i.conceptId != null && i.skillId != null && i.outcome)
          .map(i => ({ concept_id: i.conceptId, skill_id: i.skillId, outcome: i.outcome }));
        if (payload.length === 0) return;
        const { error } = await sb.rpc('rpc_lc_record_evidence', { p_evidence: payload });
        if (error) console.warn('LC.recordEvidence:', error.message);
      },
      // Resuelve pregunta→concepto(s) (lc_content_concept) + modo→skill (q.type) y registra evidencia.
      async submitFromQuestion(questionId, correct, quizType) {
        if (!this.enabled || !currentUser || questionId == null) return;
        const skillCode = ({ aux: 'recognize', match: 'recognize', speak: 'produce' })[quizType] || 'recognize';
        const { data: sk, error: eSk } = await sb.from('lc_skill')
          .select('id').eq('code', skillCode).single();
        if (eSk || !sk) { console.warn('LC.submitFromQuestion skill:', skillCode, eSk && eSk.message); return; }
        const { data: links, error: eCc } = await sb.from('lc_content_concept')
          .select('concept_id').eq('content_type', 'question').eq('content_id', questionId);
        if (eCc) { console.warn('LC.submitFromQuestion lookup:', eCc.message); return; }
        if (!links || links.length === 0) {
          console.info('LC: pregunta ' + questionId + ' sin mapping U8 → no-op (sin evidencia)');
          return;
        }
        const outcome = correct ? 'pass' : 'fail';
        await this.recordEvidence(links.map(l => ({ conceptId: l.concept_id, skillId: sk.id, outcome })));
      },
      async submitFromPhrase(phraseId, outcome, skillCode) {
        if (!this.enabled || !currentUser || phraseId == null) return;
        const { data: sk, error: eSk } = await sb.from('lc_skill')
          .select('id').eq('code', skillCode).single();
        if (eSk || !sk) { console.warn('LC.submitFromPhrase skill:', skillCode, eSk && eSk.message); return; }
        const { data: links, error: eCc } = await sb.from('lc_content_concept')
          .select('concept_id').eq('content_type', 'phrase').eq('content_id', phraseId);
        if (eCc) { console.warn('LC.submitFromPhrase lookup:', eCc.message); return; }
        if (!links || links.length === 0) return;
        await this.recordEvidence(links.map(l => ({ conceptId: l.concept_id, skillId: sk.id, outcome })));
      },
      // Iter A.5 · Hooks para verbs y linkers (U14 y U15). Mismo patrón que
      // submitFromPhrase: resolver skill → buscar content_concept → recordEvidence.
      // skillCode fijo a 'recognize' porque ambos quizzes son MCQ tipo reconocimiento.
      async submitFromVerb(verbId, correct) {
        if (!this.enabled || !currentUser || verbId == null) return;
        const { data: sk, error: eSk } = await sb.from('lc_skill')
          .select('id').eq('code', 'recognize').single();
        if (eSk || !sk) { console.warn('LC.submitFromVerb skill:', eSk && eSk.message); return; }
        const { data: links, error: eCc } = await sb.from('lc_content_concept')
          .select('concept_id').eq('content_type', 'verb').eq('content_id', verbId);
        if (eCc) { console.warn('LC.submitFromVerb lookup:', eCc.message); return; }
        if (!links || links.length === 0) return;
        const outcome = correct ? 'pass' : 'fail';
        await this.recordEvidence(links.map(l => ({ conceptId: l.concept_id, skillId: sk.id, outcome })));
      },
      async submitFromLinker(linkerId, correct) {
        if (!this.enabled || !currentUser || linkerId == null) return;
        const { data: sk, error: eSk } = await sb.from('lc_skill')
          .select('id').eq('code', 'recognize').single();
        if (eSk || !sk) { console.warn('LC.submitFromLinker skill:', eSk && eSk.message); return; }
        const { data: links, error: eCc } = await sb.from('lc_content_concept')
          .select('concept_id').eq('content_type', 'linker').eq('content_id', linkerId);
        if (eCc) { console.warn('LC.submitFromLinker lookup:', eCc.message); return; }
        if (!links || links.length === 0) return;
        const outcome = correct ? 'pass' : 'fail';
        await this.recordEvidence(links.map(l => ({ conceptId: l.concept_id, skillId: sk.id, outcome })));
      },
      // ── MVP progress · loaders read-only ──────────────────────────
      // Estado en memoria; se re-hidrata al arrancar la sesión y tras writes LC.
      mastery: new Map(),        // "cid:sid" -> {state, score, decayed_score, confidence}
      weakness: [],              // top-N conceptos débiles [{concept_id, skill_id, priority}]
      conceptNames: new Map(),   // cid -> {code, name}
      skills: new Map(),         // id (numérico) -> code
      contentByConcept: new Map(), // cid -> {phrases: [ids], questions: [ids], grammar_topics: [ids]}
      recommendation: null,      // { w, phraseIds, questionIds, skillCode, route } | null
      async loadConceptNames() {
        if (this.conceptNames.size > 0) return;
        const { data, error } = await sb.from('lc_concept').select('id, code, name');
        if (error) { console.warn('LC.loadConceptNames:', error.message); return; }
        (data || []).forEach(c => this.conceptNames.set(c.id, { code: c.code, name: c.name }));
      },
      async loadSkills() {
        if (this.skills.size > 0) return;
        const { data, error } = await sb.from('lc_skill').select('id, code');
        if (error) { console.warn('LC.loadSkills:', error.message); return; }
        (data || []).forEach(s => this.skills.set(s.id, s.code));
      },
      async loadMastery() {
        if (!this.enabled) return;
        const { data, error } = await sb.from('v_lc_mastery')
          .select('concept_id, skill_id, state, score, decayed_score, confidence');
        if (error) { console.warn('LC.loadMastery:', error.message); return; }
        this.mastery = new Map();
        (data || []).forEach(r => this.mastery.set(r.concept_id + ':' + r.skill_id, {
          state: r.state, score: r.score, decayed_score: r.decayed_score, confidence: r.confidence
        }));
      },
      async loadWeakness() {
        if (!this.enabled) return;
        const { data, error } = await sb.from('v_lc_weakness')
          .select('concept_id, skill_id, priority')
          .order('priority', { ascending: false }).limit(5);
        if (error) { console.warn('LC.loadWeakness:', error.message); return; }
        this.weakness = data || [];
      },
      async loadContentByConcept() {
        if (this.contentByConcept.size > 0) return;
        const { data, error } = await sb.from('lc_content_concept')
          .select('content_type, content_id, concept_id');
        if (error) { console.warn('LC.loadContentByConcept:', error.message); return; }
        this.contentByConcept = new Map();
        (data || []).forEach(r => {
          if (!this.contentByConcept.has(r.concept_id)) {
            this.contentByConcept.set(r.concept_id, {
              phrases: [], questions: [], grammar_topics: [], verbs: [], linkers: []
            });
          }
          const bucket = this.contentByConcept.get(r.concept_id);
          if (r.content_type === 'phrase') bucket.phrases.push(r.content_id);
          else if (r.content_type === 'question') bucket.questions.push(r.content_id);
          else if (r.content_type === 'grammar_topic') bucket.grammar_topics.push(r.content_id);
          else if (r.content_type === 'verb') bucket.verbs.push(r.content_id);
          else if (r.content_type === 'linker') bucket.linkers.push(r.content_id);
        });
      },
      async refreshCoreData() {
        if (!this.enabled) return;
        await Promise.all([this.loadConceptNames(), this.loadSkills(), this.loadContentByConcept(), this.loadMastery(), this.loadWeakness()]);
        this.pickRecommendation();
      },
      // Recorre weakness (ya ordenada por priority DESC) y elige el primer item con ruta que
      // realmente entrene la skill solicitada. produce/speak requiere phrases (shadowing) — si
      // no hay phrases se SALTA al siguiente item, no se cae a grammar (que hoy es recognize
      // por default). recognize/complete acepta grammar quiz o flashcards/shadow. Skip silencioso.
      pickRecommendation() {
        this.recommendation = null;
        if (!this.enabled || this.weakness.length === 0) return;
        for (const w of this.weakness) {
          const skillCode = this.skills.get(w.skill_id) || 'recognize';
          const bucket = this.contentByConcept.get(w.concept_id) || { phrases: [], questions: [], verbs: [], linkers: [] };
          let route = null;
          if (skillCode === 'produce' || skillCode === 'speak') {
            if (bucket.phrases.length > 0) route = 'shadow';
            // sin phrases, saltar: grammar quiz por default no entrena produce
          } else if (skillCode === 'recognize' || skillCode === 'complete' || skillCode === 'transform') {
            // Preferencia: grammar quiz > verbs quiz > linkers quiz > shadow fallback
            if (bucket.questions.length > 0) route = 'grammar';
            else if (bucket.verbs.length > 0) route = 'verbs-quiz';
            else if (bucket.linkers.length > 0) route = 'linkers-quiz';
            else if (bucket.phrases.length > 0) route = 'shadow';
          } else {
            if (bucket.phrases.length > 0) route = 'shadow';
            else if (bucket.questions.length > 0) route = 'grammar';
            else if (bucket.verbs.length > 0) route = 'verbs-quiz';
            else if (bucket.linkers.length > 0) route = 'linkers-quiz';
          }
          if (route) {
            this.recommendation = {
              w,
              phraseIds:   bucket.phrases   || [],
              questionIds: bucket.questions || [],
              verbIds:     bucket.verbs     || [],
              linkerIds:   bucket.linkers   || [],
              skillCode, route
            };
            return;
          }
        }
      },
      // Agrega el mejor state entre las skills del concepto para display resumido.
      // Precedencia: mastered > practiced > learning > rusty > unseen.
      conceptStateAggregate(conceptId) {
        const order = { unseen: 0, rusty: 1, learning: 2, practiced: 3, mastered: 4 };
        let best = 'unseen';
        for (const [key, m] of this.mastery.entries()) {
          if (key.startsWith(conceptId + ':')) {
            if ((order[m.state] || 0) > (order[best] || 0)) best = m.state;
          }
        }
        return best;
      }
    };
    window.LC = LC;   // expuesto para depuración y kill switch: LC._force = false (apaga todo)

    // ╔══════════════════════════════════════════════════════════╗
    // ║  SRS · Repetición espaciada                              ║
    // ╚══════════════════════════════════════════════════════════╝
    const SRS_LADDER = [1, 3, 7, 21, 60, 120, 240];   // días por "box"
    let srsMap = new Map();                            // "type:id" -> { box, due, interval, reps, lapses }

    const srsKey = (type, id) => type + ':' + id;

    async function loadSrs() {
      srsMap = new Map();
      if (!currentUser) return;
      const { data, error } = await sb.from('srs')
        .select('item_type,item_id,box,interval_days,due_date,reps,lapses');
      if (error) { console.warn('loadSrs:', error.message); return; }
      (data || []).forEach(r => srsMap.set(srsKey(r.item_type, r.item_id), {
        box: r.box, interval: r.interval_days, due: r.due_date, reps: r.reps, lapses: r.lapses
      }));
    }

    // quality: 'again' | 'good' | 'easy'
    async function scheduleSrs(type, id, quality) {
      if (!currentUser || id == null) return;
      const prev = srsMap.get(srsKey(type, id)) || { box: -1, reps: 0, lapses: 0 };
      let box, lapses = prev.lapses;
      if (quality === 'again') { box = 0; lapses++; }
      else if (quality === 'easy') box = Math.min((prev.box < 0 ? 0 : prev.box) + 2, SRS_LADDER.length - 1);
      else box = Math.min(prev.box + 1, SRS_LADDER.length - 1);   // 'good'
      if (box < 0) box = 0;

      const interval = SRS_LADDER[box];
      const due = new Date(); due.setDate(due.getDate() + interval);
      const dueStr = todayStr(due);

      srsMap.set(srsKey(type, id), { box, interval, due: dueStr, reps: prev.reps + 1, lapses });
      const { error } = await sb.from('srs').upsert({
        user_id: currentUser.id, item_type: type, item_id: id,
        box, interval_days: interval, due_date: dueStr,
        reps: prev.reps + 1, lapses, last_reviewed: new Date().toISOString()
      }, { onConflict: 'user_id,item_type,item_id' });
      if (error) console.warn('scheduleSrs:', error.message);
    }

    // IDs vencidos hoy (o antes) por tipo
    function dueIds(type) {
      const today = todayStr();
      const ids = [];
      srsMap.forEach((v, k) => {
        if (k.startsWith(type + ':') && v.due <= today) ids.push(Number(k.split(':')[1]));
      });
      return ids;
    }

    function openTab(name) {
      switchView(name, document.querySelector('.nav-tab[data-view="' + name + '"]'));
    }

    // ── Dashboard "Hoy" ───────────────────────────────────────────
    const TODAY_TYPES = [
      { key: 'phrase',   icon: '🃏', name: 'Frases (shadowing)' },
      { key: 'verb',     icon: '⏪', name: 'Verbos irregulares' },
      { key: 'linker',   icon: '🔗', name: 'Conectores' },
      { key: 'question', icon: '❓', name: 'Preguntas' },
    ];

    function renderToday() {
      const box = document.getElementById('today-content');
      if (!currentUser) {
        box.innerHTML = '<div class="no-data">🔐 Inicia sesión para tener tu plan diario y activar la repetición espaciada.</div>';
        return;
      }
      const counts = {};
      let total = 0;
      TODAY_TYPES.forEach(t => { counts[t.key] = dueIds(t.key).length; total += counts[t.key]; });
      const { current } = computeStreaks();

      const h = new Date().getHours();
      const greet = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
      const name  = (currentUser.email || '').split('@')[0] || '';
      const done  = studiedTodayIds.size;
      const goalPct = Math.min(100, Math.round(done / DAILY_GOAL * 100));
      const goalMet = done >= DAILY_GOAL;

      const ctaLabel = total > 0 ? '▶  Continuar repasando'
                     : goalMet   ? '✨  Aprender algo nuevo'
                     :             '▶  Empezar a practicar';
      const ctaSub = total > 0
        ? `${total} repaso${total === 1 ? '' : 's'} pendiente${total === 1 ? '' : 's'}  ·  🔥 ${current} ${current === 1 ? 'día' : 'días'}`
        : `🔥 Racha de ${current} ${current === 1 ? 'día' : 'días'} · ¡sigue así!`;

      let html = `
        <div class="today-hero2">
          <div class="today-greet2">${greet}${name ? ', ' + escapeHtml(name) : ''} 👋</div>
          <div class="today-goal">
            <div class="today-goal-top">
              <span>🎯 Meta de hoy</span>
              <span>${goalMet ? '¡cumplida! 🎉' : done + ' / ' + DAILY_GOAL + ' frases'}</span>
            </div>
            <div class="today-goal-bar"><div class="today-goal-fill" style="width:${goalPct}%"></div></div>
          </div>
          <button class="btn-continue" onclick="continueToday()">${ctaLabel}</button>
          <div class="today-cta-sub">${ctaSub}</div>
        </div>`;

      // ── Learning Core · sección MVP (ring + chips + recomendación) ─
      if (LC.enabled && LC.conceptNames.size > 0) {
        const activeUnit = LC_UNITS.find(u => u.code === _lcActiveUnitTab) || LC_UNITS[0];
        const conceptStates = activeUnit.ids.map(cid => ({
          cid,
          state: LC.conceptStateAggregate(cid),
          name: LC_SHORT_NAMES[cid] || LC.conceptNames.get(cid)?.name || ('C' + cid)
        }));
        const mastered = conceptStates.filter(s => s.state === 'mastered').length;
        const pct = Math.round((mastered / activeUnit.ids.length) * 100);
        // Total global (suma mastered de todas las unidades)
        const allIds = LC_UNITS.flatMap(u => u.ids);
        const globalMastered = allIds.filter(cid => LC.conceptStateAggregate(cid) === 'mastered').length;

        html += `
          <div class="lc-course lc-course-${activeUnit.color}">
            <div class="lc-course-head">
              <span class="lc-course-title">📖 Tu curso · ${escapeHtml(activeUnit.title)}</span>
              <span class="lc-course-count">${mastered} / ${activeUnit.ids.length} · <span class="lc-course-count-total">${globalMastered} / ${allIds.length} total</span></span>
            </div>
            <div class="lc-course-tabs">
              ${LC_UNITS.map(u => `<span class="lc-course-tab tab-${u.color}${u.code===_lcActiveUnitTab?' active':''}" onclick="switchUnitTab('${u.code}')">${u.code}</span>`).join('')}
            </div>
            <div class="lc-course-bar"><div class="lc-course-fill fill-${activeUnit.color}" style="width:${pct}%"></div></div>
            <div class="lc-course-chips">
              ${conceptStates.map(s => `<span class="lc-chip lc-chip-${s.state}" title="${LC_STATE_LABEL[s.state]}">${escapeHtml(s.name)}</span>`).join('')}
            </div>
          </div>`;

        if (LC.recommendation) {
          const w = LC.recommendation.w;
          const cName = LC_SHORT_NAMES[w.concept_id] || LC.conceptNames.get(w.concept_id)?.name || 'Concepto';
          const skillCode = LC.recommendation.skillCode;
          const skillLabel = ({ recognize: 'Reconocer', comprehend: 'Comprender', complete: 'Completar', build: 'Construir', transform: 'Transformar', listen: 'Escuchar', write: 'Escribir', speak: 'Hablar', produce: 'Producir' })[skillCode] || skillCode;
          html += `
            <div class="lc-rec">
              <div class="lc-rec-head">✨ Practica esto</div>
              <div class="lc-rec-body">
                <div class="lc-rec-concept">${escapeHtml(cName)}</div>
                <div class="lc-rec-skill">${escapeHtml(skillLabel)}</div>
              </div>
              <button class="lc-rec-btn" onclick="practiceRecommendation()">Practicar →</button>
            </div>`;
        }

        // Iter 11 · grid de badges/logros
        const bs = computeBadgeStatus();
        html += '<div class="today-section-t">Logros</div>';
        html += '<div class="lc-badges">' + LC_BADGES.map(b => {
          const on = bs.unlocked[b.id];
          const hint = b.hint(bs.s);
          return `<div class="lc-badge ${on ? 'on' : 'off'}" title="${escapeHtml(hint)}">
                    <div class="lc-badge-icon">${b.icon}</div>
                    <div class="lc-badge-name">${escapeHtml(b.name)}</div>
                  </div>`;
        }).join('') + '</div>';
      }

      if (total > 0) {
        html += '<div class="today-section-t">Repasos pendientes</div>';
        TODAY_TYPES.forEach(t => {
          if (!counts[t.key]) return;
          html += `
            <div class="today-row">
              <span class="today-icon">${t.icon}</span>
              <div class="today-info">
                <div class="today-name">${t.name}</div>
                <div class="today-count">${counts[t.key]} para repasar</div>
              </div>
              <button class="today-btn" onclick="reviewDue('${t.key}')">Repasar</button>
            </div>`;
        });
      } else {
        html += `
          <div class="today-allclear" style="padding:0.5rem 0 1.25rem">
            <div class="today-allclear-icon">🎉</div>
            <h3>¡Estás al día!</h3>
            <p>No tienes repasos pendientes. Sigue practicando y se agenda solo.</p>
          </div>`;
      }

      html += `
        <div class="today-section-t">Tu progreso</div>
        <div class="today-mini">
          <div class="today-mini-card"><div class="today-mini-num" style="color:#fb923c">${current}</div><div class="today-mini-label">Racha</div></div>
          <div class="today-mini-card"><div class="today-mini-num" style="color:#10b981">${done}</div><div class="today-mini-label">Hoy</div></div>
          <div class="today-mini-card"><div class="today-mini-num" style="color:#a855f7">${srsMap.size}</div><div class="today-mini-label">En repaso</div></div>
        </div>`;

      box.innerHTML = html;
    }

    // El botón grande: repasa lo más urgente, o practica si no hay nada
    function continueToday() {
      const order = ['phrase', 'verb', 'linker', 'question'];
      let best = null, max = 0;
      order.forEach(t => { const n = dueIds(t).length; if (n > max) { max = n; best = t; } });
      if (best) reviewDue(best);
      else openTab('shadow');
    }

    // Lanza el repaso de un tipo, filtrado a los items vencidos
    // ── Learning Core · constantes UI compartidas (renderToday + toast) ────
    const LC_U8_IDS  = [31, 32, 33, 34, 35, 36, 37];
    const LC_U14_IDS = [51, 52, 53, 54];              // past simple irregular (aaa/aba/abb/abc)
    const LC_U15_IDS = [55, 56, 57, 58, 59, 60, 61, 62]; // linkers 8 funciones
    const LC_UNITS = [
      { code: 'U8',  title: 'Presente simple', color: 'u8',  ids: LC_U8_IDS  },
      { code: 'U14', title: 'Past Simple',     color: 'u14', ids: LC_U14_IDS },
      { code: 'U15', title: 'Cohesión',        color: 'u15', ids: LC_U15_IDS }
    ];
    const LC_SHORT_NAMES = {
      // U8
      31: 'Verbos de actividad',
      32: 'WH preguntas',
      33: 'Sí/No preguntas',
      34: 'Negativas',
      35: 'Do / Does',
      36: '3ª persona -s',
      37: 'Afirmativas',
      // U14 (past simple irregular por pattern_type)
      51: 'Verbos A-A-A',
      52: 'Verbos A-B-A',
      53: 'Verbos A-B-B',
      54: 'Verbos A-B-C',
      // U15 (linkers por función)
      55: 'Añadir',
      56: 'Contrastar',
      57: 'Causa / efecto',
      58: 'Tiempo',
      59: 'Ilustrar',
      60: 'Cerrar',
      61: 'Matizar',
      62: 'Discurso'
    };
    const LC_STATE_LABEL = { unseen: 'Sin ver', learning: 'Aprendiendo', practiced: 'Practicando', rusty: 'Repasar', mastered: 'Dominado' };
    // Orden de "avance": mayor índice = mejor state. Solo notificamos upgrades.
    const LC_STATE_ORDER = { unseen: 0, rusty: 1, learning: 2, practiced: 3, mastered: 4 };
    // Iter A.6 · pestaña activa del ring en dashboard "Hoy"
    let _lcActiveUnitTab = 'U8';
    function switchUnitTab(code) {
      _lcActiveUnitTab = code;
      renderToday();
    }

    // Toast: pequeña notificación superior. Un timer global evita solapamiento.
    let _lcToastTimer = null;
    function showLCToast(message, variant) {
      const el = document.getElementById('lc-toast');
      if (!el) return;
      el.textContent = message;
      el.className = 'lc-toast show' + (variant === 'gold' ? ' lc-toast-gold' : '');
      clearTimeout(_lcToastTimer);
      _lcToastTimer = setTimeout(() => { el.className = 'lc-toast'; }, 3200);
    }

    // Snapshot pre → refreshCoreData → si algún concepto (U8/U14/U15) subió de state, notifica el primero.
    // Iter A.8.1: itera todas las unidades (no solo U8) y re-renderiza Today si es la vista activa.
    async function lcRefreshAndNotify() {
      if (!LC.enabled) return;
      const pre = new Map();
      for (const [key, m] of LC.mastery.entries()) pre.set(key, m.state);
      await LC.refreshCoreData();
      renderSidebarLCProgress();
      checkNewBadges(false); // post-hook: si desbloqueó, toast dorado
      // Si el user está en el dashboard "Hoy", refrescar el ring/chips/contador.
      if (document.querySelector('.nav-tab.active')?.getAttribute('data-view') === 'today') {
        try { renderToday(); } catch (e) { /* silencioso */ }
      }
      const allUnitIds = LC_UNITS.flatMap(u => u.ids);
      for (const cid of allUnitIds) {
        // Comparamos por celda concept:skill que ya existía o que apareció ahora.
        for (const [key, m] of LC.mastery.entries()) {
          if (!key.startsWith(cid + ':')) continue;
          const preState = pre.get(key) || 'unseen';
          const postState = m.state;
          if (preState === postState) continue;
          if ((LC_STATE_ORDER[postState] || 0) <= (LC_STATE_ORDER[preState] || 0)) continue; // solo upgrades
          const cName = LC_SHORT_NAMES[cid] || LC.conceptNames.get(cid)?.name || 'Concepto';
          const label = LC_STATE_LABEL[postState] || postState;
          showLCToast(cName + ' → ' + label);
          return; // solo 1 toast por evento
        }
      }
    }

    // ── Learning Core · badges/logros (iter 11) ────────────────────────────
    // Catálogo derivado de datos existentes (activity_days, LC.mastery, progressMap).
    // Sin SQL nuevo. Init silencioso: al primer render con localStorage vacío se
    // marcan los ya cumplidos sin toast; toasts solo para nuevos desbloqueos.
    const LC_BADGES_KEY = 'lc_badges_notified';
    const LC_BADGES = [
      { id: 'first-practice', icon: '🎉', name: 'Bienvenido',       hint: (s) => 'Tu primera práctica' },
      { id: 'streak-3',       icon: '🔥', name: '3 días seguidos',  hint: (s) => 'Racha ' + s.streak + '/3' },
      { id: 'streak-7',       icon: '🔥', name: 'Una semana',       hint: (s) => 'Racha ' + s.streak + '/7' },
      { id: 'streak-30',      icon: '🏆', name: 'Un mes',           hint: (s) => 'Racha ' + s.streak + '/30' },
      { id: 'concept-1',      icon: '⭐', name: 'Primer concepto',  hint: (s) => s.mastered + '/1 concepto dominado' },
      { id: 'concept-3',      icon: '🌟', name: 'Buen ritmo',       hint: (s) => s.mastered + '/3 conceptos' },
      { id: 'concept-7',      icon: '🎓', name: 'U8 completada',    hint: (s) => s.mastered + '/7 conceptos' },
      { id: 'phrases-50',     icon: '📚', name: '50 frases',        hint: (s) => s.phrases + '/50 estudiadas' }
    ];

    function computeBadgeStatus() {
      const streak = (typeof computeStreaks === 'function') ? (computeStreaks().current || 0) : 0;
      const mastered = LC_U8_IDS.filter(cid => LC.conceptStateAggregate(cid) === 'mastered').length;
      const phrases = (typeof progressMap !== 'undefined' && progressMap && progressMap.size) || 0;
      const anyPractice = phrases > 0 || (LC.mastery && LC.mastery.size > 0);
      const s = { streak, mastered, phrases };
      const unlocked = {
        'first-practice': anyPractice,
        'streak-3': streak >= 3,
        'streak-7': streak >= 7,
        'streak-30': streak >= 30,
        'concept-1': mastered >= 1,
        'concept-3': mastered >= 3,
        'concept-7': mastered >= 7,
        'phrases-50': phrases >= 50
      };
      return { s, unlocked };
    }

    function _getNotifiedBadges() {
      try { return JSON.parse(localStorage.getItem(LC_BADGES_KEY) || '[]'); } catch (e) { return []; }
    }
    function _setNotifiedBadges(arr) {
      try { localStorage.setItem(LC_BADGES_KEY, JSON.stringify(arr)); } catch (e) {}
    }

    // Se llama en loadAppData (post-refresh, sin toast si es primera vez con historia)
    // y en lcRefreshAndNotify (post-hook, con toast si desbloqueó ahora).
    // silent=true → marca los actualmente unlocked sin toast (init).
    function checkNewBadges(silent) {
      if (!LC.enabled) return;
      const { unlocked } = computeBadgeStatus();
      let notified = _getNotifiedBadges();
      const alreadyNotified = new Set(notified);
      const newlyUnlocked = LC_BADGES.filter(b => unlocked[b.id] && !alreadyNotified.has(b.id));
      if (newlyUnlocked.length === 0) return;
      // Persistir todos los nuevos como notificados (single set update)
      notified = notified.concat(newlyUnlocked.map(b => b.id));
      _setNotifiedBadges(notified);
      // Toast solo el primero si NO es init silencioso
      if (!silent) {
        const b = newlyUnlocked[0];
        showLCToast('¡Logro! ' + b.icon + ' ' + b.name, 'gold');
      }
    }

    // Sidebar: 3 mini-barras compactas (una por unidad activa). Solo si LC.enabled.
    function renderSidebarLCProgress() {
      const el = document.getElementById('sidebar-lc-progress');
      if (!el) return;
      if (!LC.enabled || LC.conceptNames.size === 0) {
        el.classList.remove('on');
        el.innerHTML = '';
        return;
      }
      el.classList.add('on');
      el.innerHTML = LC_UNITS.map(u => {
        const mastered = u.ids.filter(cid => LC.conceptStateAggregate(cid) === 'mastered').length;
        const pct = Math.round((mastered / u.ids.length) * 100);
        return '<span class="lc-mini-unit">' +
                 '<span class="lc-mini-num lc-mini-num-' + u.color + '">' + mastered + '/' + u.ids.length + '</span>' +
                 '<span class="lc-mini-bar"><span class="lc-mini-fill lc-mini-fill-' + u.color + '" style="width:' + pct + '%"></span></span>' +
               '</span>';
      }).join('');
    }

    // ── Onboarding LC · 3 slides al primer login autenticado ──────────────
    // Se dispara desde loadAppData tras refreshCoreData. Se marca localStorage
    // al ABRIR (más robusto si el user cierra la pestaña sin terminar).
    let _lcOnboardingSlide = 0;
    const LC_ONBOARDING_KEY = 'lc_onboarding_seen';

    function maybeShowLCOnboarding() {
      if (!LC.enabled) return;
      try {
        if (localStorage.getItem(LC_ONBOARDING_KEY)) return; // ya visto
      } catch (e) { /* localStorage no disponible: mostrar de todas formas */ }
      // Fallback anti-cache-clear: si el user ya tiene mastery hidratado (>0 celdas),
      // no es un usuario nuevo — no molestar.
      if (LC.mastery && LC.mastery.size > 0) {
        try { localStorage.setItem(LC_ONBOARDING_KEY, '1'); } catch (e) {}
        return;
      }
      showLCOnboarding();
    }

    function showLCOnboarding() {
      try { localStorage.setItem(LC_ONBOARDING_KEY, '1'); } catch (e) {}
      _lcOnboardingSlide = 0;
      const overlay = document.getElementById('lc-onboarding');
      if (!overlay) return;
      overlay.hidden = false;
      renderLCOnboardingSlide();
    }

    function renderLCOnboardingSlide() {
      const body = document.getElementById('lc-onb-body');
      const dots = document.getElementById('lc-onb-dots');
      const next = document.getElementById('lc-onb-next');
      if (!body || !dots || !next) return;
      const chips = LC_U8_IDS.map(cid => `<span class="lc-onb-chip">${escapeHtml(LC_SHORT_NAMES[cid])}</span>`).join('');
      const slides = [
        {
          html:
            '<h2>¡Bienvenido!</h2>' +
            '<p>Tu curso: <strong>Presente simple</strong> · Unidad 8</p>' +
            '<p>Vas a aprender estos 7 conceptos:</p>' +
            '<div class="lc-onb-chips">' + chips + '</div>',
          btn: 'Siguiente →'
        },
        {
          html:
            '<h2>Todo suma</h2>' +
            '<p>Cada actividad que hagas actualiza tu progreso automáticamente:</p>' +
            '<div class="lc-onb-list">' +
              '<div class="lc-onb-item"><span class="lc-onb-item-icon">🃏</span><span class="lc-onb-item-text">Rate tarjetas (<strong>Reconocer</strong>)</span></div>' +
              '<div class="lc-onb-item"><span class="lc-onb-item-icon">🎤</span><span class="lc-onb-item-text">Practica shadowing (<strong>Producir</strong>)</span></div>' +
              '<div class="lc-onb-item"><span class="lc-onb-item-icon">🎯</span><span class="lc-onb-item-text">Responde preguntas de gramática</span></div>' +
            '</div>',
          btn: 'Siguiente →'
        },
        {
          html:
            '<h2>Empieza aquí</h2>' +
            '<p>En <strong>Inicio</strong> verás siempre:</p>' +
            '<div class="lc-onb-list">' +
              '<div class="lc-onb-item"><span class="lc-onb-item-icon">📖</span><span class="lc-onb-item-text"><strong>Tu curso</strong> con qué conceptos dominas</span></div>' +
              '<div class="lc-onb-item"><span class="lc-onb-item-icon">✨</span><span class="lc-onb-item-text"><strong>Practica esto</strong> con la mejor sugerencia para hoy</span></div>' +
            '</div>',
          btn: '¡Empezar!'
        }
      ];
      const s = slides[_lcOnboardingSlide];
      body.innerHTML = s.html;
      next.textContent = s.btn;
      dots.innerHTML = slides.map((_, i) => `<span class="lc-onb-dot${i === _lcOnboardingSlide ? ' on' : ''}"></span>`).join('');
    }

    function nextLCOnboarding() {
      if (_lcOnboardingSlide < 2) {
        _lcOnboardingSlide++;
        renderLCOnboardingSlide();
      } else {
        dismissLCOnboarding();
      }
    }

    function dismissLCOnboarding() {
      const overlay = document.getElementById('lc-onboarding');
      if (overlay) overlay.hidden = true;
    }

    // Learning Core · dispatcher del botón "Practicar" de la recomendación
    // Usa LC.recommendation pre-computado por LC.pickRecommendation() en refreshCoreData.
    async function practiceRecommendation() {
      if (!LC.enabled || !LC.recommendation) return;
      const rec = LC.recommendation;
      if (rec.route === 'shadow') {
        const phraseSet = new Set(rec.phraseIds);
        openTab('shadow');
        restartShadow(allPhrases.filter(p => phraseSet.has(p.id)));
      } else if (rec.route === 'grammar') {
        const questionSet = new Set(rec.questionIds);
        await loadGrammar();
        openTab('grammar'); setGrammarMode('quiz');
        startGrammarQuiz(false, grammarData.filter(g => questionSet.has(g.id)));
      } else if (rec.route === 'verbs-quiz') {
        const verbSet = new Set(rec.verbIds);
        await loadVerbs();
        openTab('verbs'); setVerbMode('quiz');
        startVerbQuiz(false, verbsData.filter(v => verbSet.has(v.id)));
      } else if (rec.route === 'linkers-quiz') {
        const linkerSet = new Set(rec.linkerIds);
        await loadLinkers();
        openTab('linkers'); setLinkerMode('quiz');
        startQuiz(false, linkersData.filter(l => linkerSet.has(l.id)));
      }
    }

    async function reviewDue(type) {
      const ids = new Set(dueIds(type));
      if (ids.size === 0) return;
      if (type === 'verb') {
        await loadVerbs();
        openTab('verbs'); setVerbMode('quiz');
        startVerbQuiz(false, verbsData.filter(v => ids.has(v.id)));
      } else if (type === 'linker') {
        await loadLinkers();
        openTab('linkers'); setLinkerMode('quiz');
        startQuiz(false, linkersData.filter(l => ids.has(l.id)));
      } else if (type === 'question') {
        await loadGrammar();
        openTab('grammar'); setGrammarMode('quiz');
        startGrammarQuiz(false, grammarData.filter(g => ids.has(g.id)));
      } else if (type === 'phrase') {
        openTab('shadow');
        restartShadow(allPhrases.filter(p => ids.has(p.id)));
      }
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  LABORATORIO DE PRONUNCIACIÓN                            ║
    // ╚══════════════════════════════════════════════════════════╝
    let phonemesData = null, currentSound = null, labLang = 'en-US';
    const voiceByLang = {};

    async function getVoiceFor(lang) {
      if (voiceByLang[lang] !== undefined) return voiceByLang[lang];
      const voices = await new Promise(res => {
        if (window.speechSynthesis.getVoices().length) res(window.speechSynthesis.getVoices());
        else window.speechSynthesis.onvoiceschanged = () => res(window.speechSynthesis.getVoices());
      });
      const two = lang.slice(0, 2);
      const pick = voices.find(v => v.lang === lang && v.localService)
                || voices.find(v => v.lang === lang)
                || voices.find(v => v.lang.replace('_', '-') === lang)
                || voices.find(v => v.lang.startsWith(two));
      voiceByLang[lang] = pick || null;
      return voiceByLang[lang];
    }

    async function speakLang(text, lang, btn) {
      if (!('speechSynthesis' in window) || !text) return;
      window.speechSynthesis.cancel();
      const v = await getVoiceFor(lang);
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang; u.rate = 0.9; u.pitch = 1;
      if (v) u.voice = v;
      if (btn) {
        u.onstart = () => btn.classList.add('speaking');
        u.onend   = () => btn.classList.remove('speaking');
        u.onerror = () => btn.classList.remove('speaking');
      }
      window.speechSynthesis.speak(u);
    }
    function labSpeak(text, btn) { speakLang(text, labLang, btn); }

    function setLabLang(lang, el) {
      labLang = lang;
      document.querySelectorAll('.lab-accent').forEach(b => b.classList.remove('active'));
      if (el) el.classList.add('active');
    }

    async function loadLab() {
      if (phonemesData) { if (!currentSound) renderLabGrid(); return; }
      const { data, error } = await sb.from('phonemes').select('*').order('sort_order');
      if (error) {
        document.getElementById('lab-content').innerHTML =
          '<div class="no-data">No pude cargar los sonidos. ¿Ya corriste el SQL de <b>phonemes</b>?<br><span style="font-size:0.75rem">' + error.message + '</span></div>';
        return;
      }
      phonemesData = data || [];
      renderLabGrid();
    }

    function renderLabGrid() {
      currentSound = null;
      stopLabMic();
      const cats = [...new Set(phonemesData.map(p => p.category))];
      let html = '<p class="today-sub" style="text-align:center; margin-bottom:1rem">Elige un sonido para escucharlo, ver la posición de la boca y practicarlo 🔬</p>';
      cats.forEach(c => {
        html += `<div class="lab-cat-title">${c}</div><div class="lab-grid">`;
        phonemesData.filter(p => p.category === c).forEach(p => {
          html += `<button class="lab-chip" onclick="openSound(${p.id})">
                     <span class="lab-sym">${p.symbol}</span>
                     <span class="lab-name">${p.name}</span>
                   </button>`;
        });
        html += `</div>`;
      });
      document.getElementById('lab-content').innerHTML = html;
    }

    function openSound(id) {
      stopLabMic();
      const p = phonemesData.find(x => x.id === id);
      if (!p) return;
      currentSound = p;
      const spk = t => (t || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const ear = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;

      const wordChips = (p.words || []).map(w =>
        `<button class="lab-word" onclick="labSpeak('${spk(w)}', this)">${w}</button>`).join('');

      const pairRows = (p.pairs || []).map(pr => {
        const parts = pr.split('/').map(s => s.trim());
        return `<div class="lab-pair">
                  <button class="lab-pair-w" onclick="labSpeak('${spk(parts[0])}', this)">${parts[0]} 🔊</button>
                  <span class="lab-pair-vs">vs</span>
                  <button class="lab-pair-w" onclick="labSpeak('${spk(parts[1] || '')}', this)">${parts[1] || ''} 🔊</button>
                </div>`;
      }).join('');

      const phraseRows = (p.phrases || []).map((ph, i) => `
        <div class="lab-phrase-row">
          <button class="lab-audio" onclick="labSpeak('${spk(ph)}', this)">🔊</button>
          <span class="lab-phrase-txt">${ph}</span>
          <button class="btn-mic-sm" id="lab-mic-${i}" onclick="labPhraseMic(${i})" title="Grábate">🎤</button>
        </div>
        <div class="lab-phrase-fb hidden" id="lab-fb-${i}"></div>`).join('');

      document.getElementById('lab-content').innerHTML = `
        <button class="lab-back" onclick="renderLabGrid()">← Todos los sonidos</button>
        <div class="lab-detail">
          <div class="lab-detail-head">
            <div class="lab-big-sym">${p.symbol}</div>
            <div>
              <div class="lab-detail-name">${p.name}</div>
              <div class="lab-detail-asin">como en <b>${p.as_in}</b></div>
            </div>
          </div>
          <div class="lab-accents">
            <button class="lab-accent ${labLang === 'en-US' ? 'active' : ''}" onclick="setLabLang('en-US', this)">🇺🇸 US</button>
            <button class="lab-accent ${labLang === 'en-GB' ? 'active' : ''}" onclick="setLabLang('en-GB', this)">🇬🇧 UK</button>
            <button class="btn-shadow-listen" onclick="labSpeak('${spk(p.as_in)}', this)">${ear} Escuchar</button>
          </div>
          <div class="lab-sec"><div class="lab-sec-t">📖 Cómo suena</div><p>${p.explanation || ''}</p></div>
          <div class="lab-sec"><div class="lab-sec-t">👄 Posición de boca y lengua</div><p>${p.mouth || ''}</p></div>
          ${wordChips ? `<div class="lab-sec"><div class="lab-sec-t">📝 Palabras frecuentes (toca para oír)</div><div class="lab-words">${wordChips}</div></div>` : ''}
          ${pairRows ? `<div class="lab-sec"><div class="lab-sec-t">⚖️ Pares mínimos (distingue el sonido)</div>${pairRows}</div>` : ''}
          ${phraseRows ? `<div class="lab-sec"><div class="lab-sec-t">💬 Frases · escucha, grábate y compara</div>${phraseRows}</div>` : ''}
        </div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ── Micrófono del laboratorio (una frase a la vez) ────────────
    let labRecog = null, labRecorder = null, labChunks = [], labListening = false, labMicIdx = -1;

    function labPhraseMic(i) {
      if (labListening && labMicIdx === i) { stopLabMic(); return; }
      stopLabMic();
      labMicIdx = i;
      startLabMic(currentSound.phrases[i], i);
    }

    async function startLabMic(expected, i) {
      const btn = document.getElementById('lab-mic-' + i);
      const fb  = document.getElementById('lab-fb-' + i);
      fb.classList.remove('hidden');
      fb.innerHTML = '🎤 Escuchando...';

      if (useCloudSTT()) {
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { fb.innerHTML = 'No pude acceder al micrófono.'; return; }
        labChunks = [];
        let opts = {};
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
          if (MediaRecorder.isTypeSupported('audio/webm'))     opts = { mimeType: 'audio/webm' };
          else if (MediaRecorder.isTypeSupported('audio/mp4')) opts = { mimeType: 'audio/mp4' };
        }
        try { labRecorder = new MediaRecorder(stream, opts); }
        catch (e) { labRecorder = new MediaRecorder(stream); }
        labRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) labChunks.push(e.data); };
        labRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const type = (labChunks[0] && labChunks[0].type) || 'audio/webm';
          const blob = new Blob(labChunks, { type }); labChunks = [];
          if (blob.size < 1200) { fb.innerHTML = 'No te escuché. Intenta de nuevo 🎤'; return; }
          fb.innerHTML = '⏳ Comparando...';
          try {
            const ext = type.includes('mp4') ? 'mp4' : 'webm';
            const form = new FormData();
            form.append('file', blob, 'audio.' + ext);
            form.append('language', 'en');
            const { data, error } = await sb.functions.invoke('transcribe', { body: form });
            if (error) throw new Error(error.message);
            const said = (data && data.text ? data.text : '').trim();
            gradeLabPhrase(expected, said, i);
          } catch (e) { fb.innerHTML = 'Error: ' + (e.message || e); }
        };
        labRecorder.start();
        labListening = true; btn.classList.add('listening');
        fb.innerHTML = '🔴 Grabando... oprime otra vez al terminar';
      } else {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { fb.innerHTML = 'Tu navegador no soporta reconocimiento de voz.'; return; }
        labRecog = new SR();
        labRecog.lang = 'en-US'; labRecog.interimResults = false; labRecog.maxAlternatives = 3;
        labRecog.onstart  = () => { labListening = true; btn.classList.add('listening'); fb.innerHTML = '🔴 Escuchando... di la frase'; };
        labRecog.onresult = (e) => {
          let best = e.results[0][0].transcript, bs = scorePronunciation(expected, best);
          for (let k = 1; k < e.results[0].length; k++) {
            const alt = e.results[0][k].transcript, s = scorePronunciation(expected, alt);
            if (s.pct > bs.pct) { bs = s; best = alt; }
          }
          gradeLabPhrase(expected, best, i);
        };
        labRecog.onerror = (e) => { if (e.error === 'no-speech') fb.innerHTML = 'No te escuché 🎤'; stopLabMic(); };
        labRecog.onend   = () => stopLabMic();
        labRecog.start();
      }
    }

    function stopLabMic() {
      labListening = false;
      if (labMicIdx >= 0) { const b = document.getElementById('lab-mic-' + labMicIdx); if (b) b.classList.remove('listening'); }
      if (labRecog)    { try { labRecog.stop(); } catch (e) {} labRecog = null; }
      if (labRecorder && labRecorder.state !== 'inactive') { try { labRecorder.stop(); } catch (e) {} }
    }

    function gradeLabPhrase(expected, said, i) {
      stopLabMic();
      const fb = document.getElementById('lab-fb-' + i);
      if (!said) { fb.innerHTML = 'No entendí. Intenta de nuevo 🎤'; return; }
      const score = scorePronunciation(expected, said);
      const chips = score.wordResult.map(w =>
        `<span class="word-chip ${w.ok ? 'word-ok' : 'word-miss'}">${w.word}</span>`).join('');
      const cls = score.pct >= 80 ? 'score-great' : score.pct >= 50 ? 'score-good' : 'score-try';
      fb.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem">
          <b>${score.pct >= 80 ? '🏆 ¡Muy bien!' : score.pct >= 50 ? '💪 Sigue puliendo' : '🔄 Repite'}</b>
          <span class="score-badge ${cls}">${score.pct}%</span>
        </div>
        <div class="word-row" style="margin-bottom:0.3rem">${chips}</div>
        <div style="color:var(--text-muted); font-size:0.78rem">Dijiste: “${said}”</div>`;
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  CONVERSACIÓN IA (chat con Groq/Llama)                   ║
    // ╚══════════════════════════════════════════════════════════╝
    let chatHistory = [];       // [{role:'user'|'assistant', content}]
    let chatCorrect = true;
    let chatBusy = false;
    let chatStarted = false;

    const CHAT_OPENERS = {
      free:       "Hi! 😊 I'm here to chat with you in English. What would you like to talk about today?",
      smalltalk:  "Hey, nice to meet you! So, how's your day going so far?",
      interview:  "Good morning, thanks for coming in today. To start, could you tell me a little about yourself?",
      restaurant: "Good evening, welcome! Here's the menu. Can I get you something to drink first?",
      travel:     "Hello! Welcome. Do you have your passport and ticket ready?",
    };
    const CHAT_SCENARIO_ROLE = {
      free:       "Just have a friendly, natural conversation about any topic the learner brings up.",
      smalltalk:  "You are making small talk, like meeting someone new at an event. Ask about their life, work, hobbies.",
      interview:  "You are a friendly job interviewer. Ask typical interview questions one at a time and react to the answers.",
      restaurant: "You are a waiter at a restaurant. Help the learner order food and drinks.",
      travel:     "You are an airport/hotel staff member helping a traveler.",
    };
    const CHAT_LEVEL = {
      beginner:     "Use very simple English (level A1-A2): short sentences and common words.",
      intermediate: "Use clear, natural English (level B1). Keep it simple but real.",
      advanced:     "Use natural, native-level English (B2-C1).",
    };

    function buildChatSystem() {
      const scen  = document.getElementById('chat-scenario').value;
      const level = document.getElementById('chat-level').value;
      let sys = "You are a warm, encouraging English conversation partner for a Spanish-speaking learner. "
        + CHAT_SCENARIO_ROLE[scen] + " " + CHAT_LEVEL[level] + " "
        + "Keep every reply SHORT (1-3 sentences) and ALWAYS finish with a question to keep the conversation going. "
        + "Reply in English. Be natural and friendly.";
      if (chatCorrect) {
        sys += " If the learner's last message has an English mistake, begin your reply with one short correction line in this exact format: "
          + "'[CORRECT] <the corrected version>' on its own line, then continue the conversation normally. "
          + "If there is no mistake, do not add the correction line.";
      }
      return sys;
    }

    function loadChat() {
      if (!chatStarted) newChat();
    }

    function newChat() {
      chatStarted = true;
      chatHistory = [];
      stopChatMic();
      const opener = CHAT_OPENERS[document.getElementById('chat-scenario').value] || CHAT_OPENERS.free;
      chatHistory.push({ role: 'assistant', content: opener });
      renderChat();
      document.getElementById('chat-input').value = '';
    }

    function toggleChatCorrect() {
      chatCorrect = !chatCorrect;
      document.getElementById('chat-correct-toggle').classList.toggle('on', chatCorrect);
    }

    function renderChat(typing) {
      const win = document.getElementById('chat-window');
      const spk = t => (t || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      let html = chatHistory.map(m => {
        if (m.role === 'user') return `<div class="msg msg-user">${escapeHtml(m.content)}</div>`;
        // assistant: separar corrección si viene
        let corr = '', text = m.content;
        const cm = text.match(/\[CORRECT\]\s*(.+)/i);
        if (cm) { corr = cm[1].trim(); text = text.replace(/\[CORRECT\]\s*.+/i, '').trim(); }
        const correctHtml = corr ? `<span class="msg-correct">✏️ Mejor: ${escapeHtml(corr)}</span>` : '';
        return `<div class="msg-ai-row">
                  <div class="msg msg-ai">${correctHtml}${escapeHtml(text)}</div>
                  <button class="msg-speak" onclick="speakEnglish('${spk(text)}', this)">🔊</button>
                </div>`;
      }).join('');
      if (typing) html += `<div class="chat-typing" id="chat-typing">escribiendo…</div>`;
      win.innerHTML = html;
      win.scrollTop = win.scrollHeight;
    }

    function escapeHtml(s) {
      return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function autoGrowChat(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    function chatKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    }

    async function sendChat() {
      if (chatBusy) return;
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = ''; autoGrowChat(input);
      chatHistory.push({ role: 'user', content: text });
      renderChat(true);
      chatBusy = true;
      document.getElementById('chat-send').disabled = true;

      try {
        const messages = [{ role: 'system', content: buildChatSystem() }].concat(chatHistory);
        const { data, error } = await sb.functions.invoke('chat', { body: { messages } });
        if (error) throw new Error(error.message || 'Error en el chat');
        const reply = (data && data.reply ? data.reply : '').trim();
        if (!reply) throw new Error('Respuesta vacía del modelo');
        chatHistory.push({ role: 'assistant', content: reply });
        renderChat();
        // Leer la respuesta en voz alta (sin la línea de corrección)
        const spoken = reply.replace(/\[CORRECT\]\s*.+/i, '').trim();
        speakEnglish(spoken);
      } catch (e) {
        chatHistory.push({ role: 'assistant', content: '⚠️ ' + (e.message || e) + ' (¿ya desplegaste la función "chat"?)' });
        renderChat();
      } finally {
        chatBusy = false;
        document.getElementById('chat-send').disabled = false;
      }
    }

    // ── Micrófono del chat (dicta al input) ───────────────────────
    let chatRecog = null, chatRecorder = null, chatChunks = [], chatListening = false;

    function toggleChatMic() { chatListening ? stopChatMic() : startChatMic(); }

    async function startChatMic() {
      const btn = document.getElementById('chat-mic');
      const input = document.getElementById('chat-input');
      if (useCloudSTT()) {
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { input.placeholder = 'No pude acceder al micrófono.'; return; }
        chatChunks = [];
        let opts = {};
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
          if (MediaRecorder.isTypeSupported('audio/webm'))     opts = { mimeType: 'audio/webm' };
          else if (MediaRecorder.isTypeSupported('audio/mp4')) opts = { mimeType: 'audio/mp4' };
        }
        try { chatRecorder = new MediaRecorder(stream, opts); }
        catch (e) { chatRecorder = new MediaRecorder(stream); }
        chatRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) chatChunks.push(e.data); };
        chatRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const type = (chatChunks[0] && chatChunks[0].type) || 'audio/webm';
          const blob = new Blob(chatChunks, { type }); chatChunks = [];
          if (blob.size < 1200) return;
          input.placeholder = '⏳ Transcribiendo...';
          try {
            const ext = type.includes('mp4') ? 'mp4' : 'webm';
            const form = new FormData();
            form.append('file', blob, 'audio.' + ext);
            form.append('language', 'en');
            const { data, error } = await sb.functions.invoke('transcribe', { body: form });
            if (error) throw new Error(error.message);
            const said = (data && data.text ? data.text : '').trim();
            input.placeholder = 'Escribe en inglés...';
            if (said) { input.value = (input.value ? input.value + ' ' : '') + said; autoGrowChat(input); input.focus(); }
          } catch (e) { input.placeholder = 'Error al transcribir'; }
        };
        chatRecorder.start();
        chatListening = true; btn.classList.add('listening');
      } else {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { input.placeholder = 'Tu navegador no soporta voz. Escribe.'; return; }
        chatRecog = new SR();
        chatRecog.lang = 'en-US'; chatRecog.interimResults = false; chatRecog.maxAlternatives = 1;
        chatRecog.onstart  = () => { chatListening = true; btn.classList.add('listening'); };
        chatRecog.onresult = (e) => {
          const said = e.results[0][0].transcript.trim();
          if (said) { input.value = (input.value ? input.value + ' ' : '') + said; autoGrowChat(input); input.focus(); }
        };
        chatRecog.onerror = () => stopChatMic();
        chatRecog.onend   = () => stopChatMic();
        chatRecog.start();
      }
    }

    function stopChatMic() {
      chatListening = false;
      const btn = document.getElementById('chat-mic');
      if (btn) btn.classList.remove('listening');
      if (chatRecog)    { try { chatRecog.stop(); } catch (e) {} chatRecog = null; }
      if (chatRecorder && chatRecorder.state !== 'inactive') { try { chatRecorder.stop(); } catch (e) {} }
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  DICCIONARIO (busca palabra: fonética, audio, definición)║
    // ╚══════════════════════════════════════════════════════════╝
    let dictCurrent = null;   // { word, ipa, audio }

    // Fetch con reintentos (la API gratuita falla de forma intermitente por palabra)
    async function fetchDict(word, attempts = 3) {
      const url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word);
      for (let i = 0; i < attempts; i++) {
        try {
          const res = await fetch(url);
          if (res.status === 404) return { notFound: true };
          if (res.ok) return { data: await res.json() };
        } catch (e) { /* red/CORS transitorio -> reintentar */ }
        await new Promise(r => setTimeout(r, 400 + i * 300));
      }
      return { error: true };
    }

    async function lookupWord() {
      const input = document.getElementById('dict-input');
      const word = (input.value || '').trim().toLowerCase().replace(/[^a-z' -]/g, '');
      if (!word) return;
      const box = document.getElementById('dict-content');
      box.innerHTML = '<div class="dict-status">🔎 Buscando "' + word + '"...</div>';

      const r = await fetchDict(word);
      if (r.data) { renderDict(word, r.data); return; }

      dictCurrent = { word, ipa: '', audio: null };
      if (r.notFound) {
        box.innerHTML = `<div class="dict-status">No encontré "<b>${escapeHtml(word)}</b>" 😕<br>
          <span style="font-size:0.8rem">Revisa la ortografía. Aun así puedes oírla:</span><br>
          <button class="dict-abtn" style="margin:0.75rem auto 0; display:inline-flex" onclick="speakLang('${word.replace(/'/g, "\\'")}','en-US', this)">🔊 Escuchar</button></div>`;
      } else {
        box.innerHTML = `<div class="dict-status">El diccionario no respondió (a veces se pone lento).<br>
          <button class="dict-abtn" style="margin:0.75rem auto 0; display:inline-flex" onclick="lookupWord()">🔄 Reintentar</button></div>`;
      }
    }

    function renderDict(word, entries) {
      const e = entries[0];
      const ipa = e.phonetic || (e.phonetics.find(p => p.text) || {}).text || '';
      const audio = (e.phonetics.find(p => p.audio) || {}).audio || null;
      dictCurrent = { word, ipa, audio };
      const spk = t => (t || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

      // Definiciones (hasta 2 por tipo, máx 3 tipos)
      let meaningsHtml = '';
      (e.meanings || []).slice(0, 3).forEach(m => {
        meaningsHtml += `<div class="dict-pos">${m.partOfSpeech}</div>`;
        (m.definitions || []).slice(0, 2).forEach(d => {
          meaningsHtml += `<div class="dict-def">${escapeHtml(d.definition)}</div>`;
          if (d.example) meaningsHtml += `<div class="dict-ex">“${escapeHtml(d.example)}”</div>`;
        });
      });

      const nativeBtn = audio
        ? `<button class="dict-abtn" onclick="playAudioUrl('${spk(audio)}', this)">🎙️ Nativo</button>` : '';
      const loggedSave = currentUser
        ? `<button class="dict-abtn save" id="dict-save" onclick="saveWord()">➕ Guardar para practicar</button>`
        : `<button class="dict-abtn save" onclick="alert('Inicia sesión para guardar palabras.')">➕ Guardar</button>`;

      document.getElementById('dict-content').innerHTML = `
        <div class="dict-card">
          <div class="dict-word-row">
            <span class="dict-word">${escapeHtml(word)}</span>
            ${ipa ? `<span class="dict-ipa">${escapeHtml(ipa)}</span>` : ''}
          </div>
          <div class="dict-audio-btns">
            ${nativeBtn}
            <button class="dict-abtn" onclick="speakLang('${spk(word)}','en-US', this)">🇺🇸 US</button>
            <button class="dict-abtn" onclick="speakLang('${spk(word)}','en-GB', this)">🇬🇧 UK</button>
            <button class="dict-abtn mic" id="dict-mic" onclick="toggleDictMic()">🎤 Practicar</button>
            ${loggedSave}
          </div>
          <div class="dict-mic-fb hidden" id="dict-mic-fb"></div>
          ${meaningsHtml}
        </div>`;
    }

    function playAudioUrl(url, btn) {
      try {
        const a = new Audio(url.startsWith('//') ? 'https:' + url : url);
        if (btn) { btn.classList.add('speaking'); a.onended = () => btn.classList.remove('speaking'); a.onerror = () => btn.classList.remove('speaking'); }
        a.play();
      } catch (e) {}
    }

    // ── Practicar pronunciación de la palabra ─────────────────────
    let dictRecog = null, dictRecorder = null, dictChunks = [], dictListening = false;

    function toggleDictMic() { dictListening ? stopDictMic() : startDictMic(); }

    async function startDictMic() {
      if (!dictCurrent) return;
      const expected = dictCurrent.word;
      const btn = document.getElementById('dict-mic');
      const fb  = document.getElementById('dict-mic-fb');
      fb.classList.remove('hidden'); fb.innerHTML = '🎤 Escuchando...';
      if (useCloudSTT()) {
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { fb.innerHTML = 'No pude acceder al micrófono.'; return; }
        dictChunks = [];
        let opts = {};
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
          if (MediaRecorder.isTypeSupported('audio/webm'))     opts = { mimeType: 'audio/webm' };
          else if (MediaRecorder.isTypeSupported('audio/mp4')) opts = { mimeType: 'audio/mp4' };
        }
        try { dictRecorder = new MediaRecorder(stream, opts); }
        catch (e) { dictRecorder = new MediaRecorder(stream); }
        dictRecorder.ondataavailable = ev => { if (ev.data && ev.data.size > 0) dictChunks.push(ev.data); };
        dictRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const type = (dictChunks[0] && dictChunks[0].type) || 'audio/webm';
          const blob = new Blob(dictChunks, { type }); dictChunks = [];
          if (blob.size < 1000) { fb.innerHTML = 'No te escuché 🎤'; return; }
          fb.innerHTML = '⏳ Comparando...';
          try {
            const ext = type.includes('mp4') ? 'mp4' : 'webm';
            const form = new FormData();
            form.append('file', blob, 'audio.' + ext);
            form.append('language', 'en');
            const { data, error } = await sb.functions.invoke('transcribe', { body: form });
            if (error) throw new Error(error.message);
            gradeDict(expected, (data && data.text ? data.text : '').trim());
          } catch (e) { fb.innerHTML = 'Error: ' + (e.message || e); }
        };
        dictRecorder.start();
        dictListening = true; btn.classList.add('listening');
        fb.innerHTML = '🔴 Grabando... oprime otra vez al terminar';
      } else {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { fb.innerHTML = 'Tu navegador no soporta reconocimiento de voz.'; return; }
        dictRecog = new SR();
        dictRecog.lang = 'en-US'; dictRecog.interimResults = false; dictRecog.maxAlternatives = 3;
        dictRecog.onstart  = () => { dictListening = true; btn.classList.add('listening'); fb.innerHTML = '🔴 Escuchando...'; };
        dictRecog.onresult = (ev) => {
          let best = ev.results[0][0].transcript, bs = scorePronunciation(expected, best);
          for (let k = 1; k < ev.results[0].length; k++) {
            const alt = ev.results[0][k].transcript, s = scorePronunciation(expected, alt);
            if (s.pct > bs.pct) { bs = s; best = alt; }
          }
          gradeDict(expected, best);
        };
        dictRecog.onerror = (ev) => { if (ev.error === 'no-speech') fb.innerHTML = 'No te escuché 🎤'; stopDictMic(); };
        dictRecog.onend   = () => stopDictMic();
        dictRecog.start();
      }
    }

    function stopDictMic() {
      dictListening = false;
      const btn = document.getElementById('dict-mic');
      if (btn) btn.classList.remove('listening');
      if (dictRecog)    { try { dictRecog.stop(); } catch (e) {} dictRecog = null; }
      if (dictRecorder && dictRecorder.state !== 'inactive') { try { dictRecorder.stop(); } catch (e) {} }
    }

    function gradeDict(expected, said) {
      stopDictMic();
      const fb = document.getElementById('dict-mic-fb');
      const score = scorePronunciation(expected, said);
      const cls = score.pct >= 80 ? 'score-great' : score.pct >= 50 ? 'score-good' : 'score-try';
      fb.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center">
          <b>${score.pct >= 80 ? '🏆 ¡Muy bien!' : score.pct >= 50 ? '💪 Casi' : '🔄 Repite'}</b>
          <span class="score-badge ${cls}">${score.pct}%</span>
        </div>
        <div style="color:var(--text-muted); font-size:0.78rem; margin-top:0.3rem">Escuché: “${said || '—'}”</div>`;
    }

    // ── Guardar palabra en "Mi vocabulario" (→ flashcards + SRS) ──
    async function saveWord() {
      if (!currentUser || !dictCurrent) return;
      const word = dictCurrent.word;
      const btn = document.getElementById('dict-save');
      // ¿Ya la tienes?
      if (allPhrases.some(p => (p.phrase || '').toLowerCase() === word)) {
        showDictToast('Ya tienes "' + word + '" guardada. 👍');
        return;
      }
      btn.textContent = '⏳ Guardando...'; btn.disabled = true;
      try {
        // Traducción al español vía Groq
        let translation = '';
        try {
          const { data } = await sb.functions.invoke('chat', { body: { messages: [
            { role: 'system', content: 'You are a translator. Translate the given English word to Spanish. Reply with ONLY the Spanish translation, no punctuation, no extra words.' },
            { role: 'user', content: word }
          ] } });
          translation = (data && data.reply ? data.reply : '').trim().replace(/^["'.]+|["'.]+$/g, '');
        } catch (e) {}
        if (!translation) translation = '(sin traducción)';

        const newId = Math.max(0, ...allPhrases.map(p => p.id || 0)) + 1;
        const { error } = await sb.from('phrases').insert({
          phrase_id: newId,
          phrase_name: word,
          phrase_translation: translation,
          description: dictCurrent.ipa || '',
          category: 'Mi vocabulario'
        });
        if (error) throw new Error(error.message);

        // Agregar en memoria para que aparezca sin recargar
        allPhrases.push({ id: newId, phrase: word, translation, description: dictCurrent.ipa || '', category: 'Mi vocabulario' });
        loadCategories();
        btn.textContent = '✓ Guardada'; btn.classList.add('saved');
        showDictToast('✓ "' + word + '" → "' + translation + '" guardada. La verás en Tarjetas y Shadowing (categoría "Mi vocabulario").');
      } catch (e) {
        btn.textContent = '➕ Guardar para practicar'; btn.disabled = false;
        showDictToast('No pude guardar: ' + (e.message || e) + ' (¿corriste el SQL del permiso?)');
      }
    }

    function showDictToast(msg) {
      const card = document.querySelector('.dict-card') || document.getElementById('dict-content');
      let t = document.getElementById('dict-toast');
      if (!t) { t = document.createElement('div'); t.id = 'dict-toast'; t.className = 'dict-toast'; card.appendChild(t); }
      t.textContent = msg;
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  AGREGAR FRASE (captura rápida: español → inglés → banco)║
    // ╚══════════════════════════════════════════════════════════╝
    function openAddPhrase() {
      if (!currentUser) { alert('Inicia sesión para agregar tus propias frases.'); return; }
      document.getElementById('addp-source').value = '';
      document.getElementById('addp-en').value = '';
      document.getElementById('addp-es').value = '';
      document.getElementById('addp-preview').classList.add('hidden');
      setAddMsg('', '');
      document.getElementById('addphrase-modal').classList.remove('hidden');
      setTimeout(() => document.getElementById('addp-source').focus(), 100);
    }
    function closeAddPhrase() {
      stopAddMic();
      document.getElementById('addphrase-modal').classList.add('hidden');
    }
    function setAddMsg(text, type) {
      const el = document.getElementById('addp-msg');
      el.textContent = text; el.className = 'addp-msg ' + (type || '');
    }

    async function translatePhrase() {
      const src = document.getElementById('addp-source').value.trim();
      if (!src) return;
      const btn = document.getElementById('addp-translate');
      btn.disabled = true; btn.textContent = '⏳ Traduciendo...';
      setAddMsg('', '');
      try {
        const sys = 'You translate short phrases for a Spanish-speaking English learner. '
          + 'The input may be Spanish or English. Reply with ONLY a JSON object like '
          + '{"en":"natural idiomatic English","es":"Spanish"}. '
          + 'Make the English sound like a real native speaker would say it, not a literal translation. No extra text.';
        const { data, error } = await sb.functions.invoke('chat', { body: { messages: [
          { role: 'system', content: sys }, { role: 'user', content: src }
        ] } });
        if (error) throw new Error(error.message);
        let txt = (data && data.reply ? data.reply : '').trim().replace(/```json|```/g, '').trim();
        const m = txt.match(/\{[\s\S]*\}/);
        const obj = JSON.parse(m ? m[0] : txt);
        const en = (obj.en || '').trim(), es = (obj.es || '').trim();
        if (!en) throw new Error('sin traducción');
        document.getElementById('addp-en').value = en;
        document.getElementById('addp-es').value = es || src;
        document.getElementById('addp-preview').classList.remove('hidden');
        speakEnglish(en);
      } catch (e) {
        setAddMsg('No pude traducir: ' + (e.message || e), 'err');
      } finally {
        btn.disabled = false; btn.textContent = '✨ Traducir';
      }
    }

    async function saveNewPhrase() {
      const en = document.getElementById('addp-en').value.trim();
      const es = document.getElementById('addp-es').value.trim();
      if (!en || !es) { setAddMsg('Faltan el inglés o el español.', 'err'); return; }
      if (allPhrases.some(p => (p.phrase || '').toLowerCase() === en.toLowerCase())) {
        setAddMsg('Ya tienes esa frase guardada. 👍', 'ok'); return;
      }
      const newId = Math.max(0, ...allPhrases.map(p => p.id || 0)) + 1;
      const { error } = await sb.from('phrases').insert({
        phrase_id: newId, phrase_name: en, phrase_translation: es, category: 'Mis frases'
      });
      if (error) { setAddMsg('No pude guardar: ' + error.message, 'err'); return; }
      allPhrases.push({ id: newId, phrase: en, translation: es, description: '', category: 'Mis frases' });
      loadCategories();
      setAddMsg('✓ Guardada: "' + en + '"  →  la verás en Tarjetas y Shadowing (categoría "Mis frases").', 'ok');
      document.getElementById('addp-preview').classList.add('hidden');
      document.getElementById('addp-source').value = '';
    }

    // Dictado en español para agregar frase
    let addRecog = null, addRecorder = null, addChunks = [], addListening = false;
    function toggleAddMic() { addListening ? stopAddMic() : startAddMic(); }

    async function startAddMic() {
      const btn = document.getElementById('addp-mic');
      const input = document.getElementById('addp-source');
      if (useCloudSTT()) {
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { setAddMsg('No pude acceder al micrófono.', 'err'); return; }
        addChunks = [];
        let opts = {};
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
          if (MediaRecorder.isTypeSupported('audio/webm'))     opts = { mimeType: 'audio/webm' };
          else if (MediaRecorder.isTypeSupported('audio/mp4')) opts = { mimeType: 'audio/mp4' };
        }
        try { addRecorder = new MediaRecorder(stream, opts); }
        catch (e) { addRecorder = new MediaRecorder(stream); }
        addRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) addChunks.push(e.data); };
        addRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const type = (addChunks[0] && addChunks[0].type) || 'audio/webm';
          const blob = new Blob(addChunks, { type }); addChunks = [];
          if (blob.size < 1200) return;
          setAddMsg('⏳ Transcribiendo...', '');
          try {
            const ext = type.includes('mp4') ? 'mp4' : 'webm';
            const form = new FormData();
            form.append('file', blob, 'audio.' + ext);
            form.append('language', 'es');   // dictado en español
            const { data, error } = await sb.functions.invoke('transcribe', { body: form });
            if (error) throw new Error(error.message);
            const said = (data && data.text ? data.text : '').trim();
            setAddMsg('', '');
            if (said) { input.value = (input.value ? input.value + ' ' : '') + said; input.focus(); }
          } catch (e) { setAddMsg('Error al transcribir', 'err'); }
        };
        addRecorder.start();
        addListening = true; btn.classList.add('listening');
      } else {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { setAddMsg('Tu navegador no soporta voz. Escribe la frase.', 'err'); return; }
        addRecog = new SR();
        addRecog.lang = 'es-ES'; addRecog.interimResults = false; addRecog.maxAlternatives = 1;
        addRecog.onstart  = () => { addListening = true; btn.classList.add('listening'); };
        addRecog.onresult = (e) => {
          const said = e.results[0][0].transcript.trim();
          if (said) { input.value = (input.value ? input.value + ' ' : '') + said; input.focus(); }
        };
        addRecog.onerror = () => stopAddMic();
        addRecog.onend   = () => stopAddMic();
        addRecog.start();
      }
    }

    function stopAddMic() {
      addListening = false;
      const btn = document.getElementById('addp-mic');
      if (btn) btn.classList.remove('listening');
      if (addRecog)    { try { addRecog.stop(); } catch (e) {} addRecog = null; }
      if (addRecorder && addRecorder.state !== 'inactive') { try { addRecorder.stop(); } catch (e) {} }
    }

    // ── Fetch all phrases once from Supabase ──────────────────────
    async function fetchAllPhrases() {
      // Supabase devuelve máx. 1000 filas por consulta -> paginamos para traerlas todas
      let all = [], from = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await sb
          .from('phrases')
          .select('phrase_id,phrase_name,phrase_translation,description,category')
          .order('phrase_id')
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        all = all.concat(data || []);
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
      return all.map(r => ({
        id: r.phrase_id,
        phrase: r.phrase_name,
        translation: r.phrase_translation,
        description: r.description || '',
        category: r.category || ''
      }));
    }

    // ── Cargar progreso del usuario ───────────────────────────────
    async function loadProgress() {
      progressMap = new Map();
      if (!currentUser) return;
      const { data, error } = await sb
        .from('user_progress')
        .select('phrase_id,status,best_score,attempts');
      if (error) { console.warn('progress:', error.message); return; }
      data.forEach(r => progressMap.set(r.phrase_id, {
        status: r.status, best_score: r.best_score, attempts: r.attempts
      }));
    }

    // ── Guardar/actualizar progreso de una frase ──────────────────
    async function saveProgress(phraseId, { status, score } = {}) {
      if (!currentUser) return;
      const existing = progressMap.get(phraseId) || { status: 'practicing', best_score: 0, attempts: 0 };
      const row = {
        user_id:    currentUser.id,
        phrase_id:  phraseId,
        status:     status || existing.status || 'practicing',
        best_score: Math.max(existing.best_score || 0, score || 0),
        attempts:   (existing.attempts || 0) + (score !== undefined ? 1 : 0),
        last_practiced: new Date().toISOString()
      };
      progressMap.set(phraseId, { status: row.status, best_score: row.best_score, attempts: row.attempts });
      const { error } = await sb.from('user_progress')
        .upsert(row, { onConflict: 'user_id,phrase_id' });
      if (error) console.warn('saveProgress:', error.message);
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  RACHA DIARIA (meta de frases)                           ║
    // ╚══════════════════════════════════════════════════════════╝
    const DAILY_GOAL = 10;               // frases distintas por día para "cumplir"
    let studiedTodayIds = new Set();     // ids estudiados hoy
    let dailyGoalMet    = false;
    let activityDays    = [];            // [{ day:'YYYY-MM-DD', goal_met:bool, count:int }]

    function todayStr(d) {
      d = d || new Date();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    }

    // Cargar historial de actividad y calcular racha
    async function loadStreak() {
      activityDays = [];
      studiedTodayIds = new Set();
      dailyGoalMet = false;
      if (!currentUser) { document.getElementById('streak-bar').classList.add('hidden'); return; }

      const since = new Date(); since.setDate(since.getDate() - 90);
      const { data, error } = await sb
        .from('activity_days')
        .select('day,phrase_ids,goal_met')
        .gte('day', todayStr(since))
        .order('day', { ascending: true });
      if (error) { console.warn('loadStreak:', error.message); }
      else {
        activityDays = (data || []).map(r => ({
          day: r.day,
          goal_met: r.goal_met,
          count: (r.phrase_ids || []).length
        }));
        const todayRow = (data || []).find(r => r.day === todayStr());
        if (todayRow) {
          studiedTodayIds = new Set(todayRow.phrase_ids || []);
          dailyGoalMet = todayRow.goal_met;
        }
      }
      // La barra de racha ya no se muestra en Tarjetas (está en el sidebar e Inicio)
      document.getElementById('streak-goal').textContent = DAILY_GOAL;
      updateStreakUI();
    }

    // Marcar una frase como estudiada hoy (la llaman flip y pronunciación)
    async function markPhraseStudied(phraseId) {
      if (!currentUser || phraseId == null) return;
      if (studiedTodayIds.has(phraseId)) return;
      studiedTodayIds.add(phraseId);
      const ids = [...studiedTodayIds];
      const metNow = ids.length >= DAILY_GOAL;
      const justMet = metNow && !dailyGoalMet;
      dailyGoalMet = metNow;

      // Actualizar/insertar el día de hoy en el historial local
      const t = todayStr();
      const existing = activityDays.find(a => a.day === t);
      if (existing) { existing.count = ids.length; existing.goal_met = metNow; }
      else activityDays.push({ day: t, goal_met: metNow, count: ids.length });

      updateStreakUI();
      if (justMet) celebrateGoal();

      const { error } = await sb.from('activity_days').upsert({
        user_id: currentUser.id, day: t, phrase_ids: ids, goal_met: metNow,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,day' });
      if (error) console.warn('markPhraseStudied:', error.message);
    }

    // Calcular racha actual y mejor racha a partir de los días con meta cumplida
    function computeStreaks() {
      const met = new Set(activityDays.filter(a => a.goal_met).map(a => a.day));
      // Racha actual: cuenta hacia atrás desde hoy (o ayer si hoy aún no se cumple)
      let current = 0;
      let d = new Date();
      if (!met.has(todayStr(d))) d.setDate(d.getDate() - 1);
      while (met.has(todayStr(d))) { current++; d.setDate(d.getDate() - 1); }
      // Mejor racha: el tramo consecutivo más largo
      const sorted = [...met].sort();
      let best = 0, run = 0, prev = null;
      sorted.forEach(ds => {
        if (prev) {
          const diff = (new Date(ds) - new Date(prev)) / 86400000;
          run = (Math.round(diff) === 1) ? run + 1 : 1;
        } else run = 1;
        best = Math.max(best, run);
        prev = ds;
      });
      return { current, best, totalActive: activityDays.length };
    }

    function updateStreakUI() {
      const { current } = computeStreaks();
      const count = studiedTodayIds.size;
      document.getElementById('streak-count').textContent = current;
      document.getElementById('streak-today').textContent = count;
      const pct = Math.min(100, Math.round((count / DAILY_GOAL) * 100));
      document.getElementById('streak-mini-fill').style.width = pct + '%';
      document.getElementById('streak-done').classList.toggle('hidden', !dailyGoalMet);
      const ss = document.getElementById('sidebar-streak');
      if (ss && currentUser) ss.textContent = '🔥 ' + current + (current === 1 ? ' día' : ' días');
    }

    function celebrateGoal() {
      const flame = document.getElementById('streak-flame');
      flame.classList.remove('pop'); void flame.offsetWidth; flame.classList.add('pop');
    }

    function shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    // ── Categories (computed from cache) ──────────────────────────
    function loadCategories() {
      const counts = {};
      allPhrases.forEach(p => {
        const c = p.category || 'Sin categoría';
        counts[c] = (counts[c] || 0) + 1;
      });
      const cats = Object.entries(counts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      const bar = document.getElementById('category-bar');
      const total = allPhrases.length;

      let html = `<div class="cat-chip active" data-cat="all" onclick="selectCategory('all', this)">
                    🌐 Todas <span class="cat-count">${total}</span>
                  </div>`;

      const icons = {
        'Conversación General': '💬',
        'Negocios': '💼',
        'Turismo': '✈️',
        'Restaurante/Comida': '🍽️',
        'Salud': '🏥',
        'Educación': '📚',
        'Finanzas': '💰'
      };

      cats.forEach(c => {
        const icon = icons[c.name] || '🏷️';
        html += `<div class="cat-chip" data-cat="${c.name}" onclick="selectCategory('${c.name.replace(/'/g, "\\'")}', this)">
                   ${icon} ${c.name} <span class="cat-count">${c.count}</span>
                 </div>`;
      });

      // ── Learning Core · chips de concepto U8 (solo si LC hidratado) ──
      // Un chip por concepto U8 con phrases mapeadas. Formato: "Negativas (14)".
      // Filtro compuesto AND con activeCategory (seleccionar concepto resetea category).
      if (LC.enabled && LC.contentByConcept.size > 0) {
        const conceptChips = LC_U8_IDS
          .map(cid => ({ cid, count: (LC.contentByConcept.get(cid)?.phrases || []).length }))
          .filter(c => c.count > 0);
        if (conceptChips.length > 0) {
          html += '<div class="cat-sep" title="Filtrar por concepto U8">·</div>';
          conceptChips.forEach(c => {
            const name = LC_SHORT_NAMES[c.cid] || LC.conceptNames.get(c.cid)?.name || ('C' + c.cid);
            const active = activeConcept === c.cid ? ' active' : '';
            html += `<div class="cat-chip cat-chip-concept${active}" data-concept="${c.cid}" onclick="selectConcept(${c.cid}, this)">
                       ✨ ${escapeHtml(name)} <span class="cat-count">${c.count}</span>
                     </div>`;
          });
        }
      }

      bar.innerHTML = html;
      bar.classList.remove('hidden');
    }

    function selectCategory(cat, el) {
      activeCategory = cat;
      activeConcept = null;  // seleccionar categoría desactiva el filtro por concepto
      document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      // Reset session for new category
      seen.clear();
      document.getElementById('completed').classList.add('hidden');
      document.getElementById('main-content').classList.remove('hidden');
      loadPhrases();
    }

    function selectConcept(cid, el) {
      activeConcept = cid;
      activeCategory = 'all';  // filtro por concepto sustituye al de categoría
      document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      seen.clear();
      document.getElementById('completed').classList.add('hidden');
      document.getElementById('main-content').classList.remove('hidden');
      loadPhrases();
    }

    // ── Practice log (for report) ─────────────────────────────────
    let practiceLog = [];  // { phrase, translation, score, said, timestamp }

    // ── Timer ─────────────────────────────────────────────────────
    let timerSeconds  = 0;
    let timerInterval = null;
    let timerRunning  = false;

    function startTimer() {
      if (timerRunning) return;
      timerRunning = true;
      document.getElementById('btn-timer-start').classList.add('hidden');
      document.getElementById('btn-timer-stop').classList.remove('hidden');
      document.getElementById('timer-display').className = 'timer-display running';
      timerInterval = setInterval(() => {
        timerSeconds++;
        document.getElementById('timer-display').textContent = formatTime(timerSeconds);
      }, 1000);
    }

    function stopTimer() {
      if (!timerRunning) return;
      clearInterval(timerInterval);
      timerRunning = false;
      document.getElementById('btn-timer-stop').classList.add('hidden');
      document.getElementById('btn-timer-start').classList.remove('hidden');
      document.getElementById('timer-display').className = 'timer-display paused';
      showReport();
    }

    function resetTimer() {
      clearInterval(timerInterval);
      timerRunning = false;
      timerSeconds = 0;
      document.getElementById('timer-display').textContent = '00:00:00';
      document.getElementById('timer-display').className   = 'timer-display paused';
      document.getElementById('btn-timer-stop').classList.add('hidden');
      document.getElementById('btn-timer-start').classList.remove('hidden');
      practiceLog = [];
    }

    function formatTime(s) {
      const h = String(Math.floor(s / 3600)).padStart(2,'0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2,'0');
      const sec = String(s % 60).padStart(2,'0');
      return `${h}:${m}:${sec}`;
    }

    function formatTimeShort(s) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    }

    // ── Report ────────────────────────────────────────────────────
    function showReport() {
      const modal    = document.getElementById('report-modal');
      const attempts = practiceLog.length;
      const failed   = practiceLog.filter(l => l.score < 70);
      const perfect  = practiceLog.filter(l => l.score === 100).length;
      const avgScore = attempts > 0
        ? Math.round(practiceLog.reduce((a,b) => a + b.score, 0) / attempts)
        : null;

      // Subtitle
      document.getElementById('report-subtitle').textContent =
        `${new Date().toLocaleDateString('es-CO', { weekday:'long', day:'numeric', month:'long' })} · ${formatTimeShort(timerSeconds)} de práctica`;

      // Score circle
      const circleWrap = document.getElementById('score-circle-wrap');
      if (avgScore !== null) {
        const cls = avgScore >= 80 ? 'score-circle-great' : avgScore >= 50 ? 'score-circle-good' : 'score-circle-try';
        circleWrap.innerHTML = `
          <div class="score-circle ${cls}">
            <span>${avgScore}%</span>
            <span class="score-circle-label">AVG</span>
          </div>`;
      } else {
        circleWrap.innerHTML = `<div class="score-circle score-circle-try" style="font-size:1rem; color:var(--text-muted)">Sin intentos</div>`;
      }

      // Summary
      document.getElementById('rep-time').textContent     = formatTimeShort(timerSeconds);
      document.getElementById('rep-seen').textContent     = seen.size;
      document.getElementById('rep-attempts').textContent = attempts;

      // Failed phrases
      const failsEl = document.getElementById('rep-fails');
      if (failed.length === 0) {
        failsEl.innerHTML = `<div class="no-data">🎉 ¡No hay frases fallidas! Excelente sesión.</div>`;
      } else {
        // Sort by score ascending (worst first)
        const sorted = [...failed].sort((a,b) => a.score - b.score);
        failsEl.innerHTML = sorted.map(l => `
          <div class="fail-item">
            <div>
              <div class="fail-phrase">${l.phrase}</div>
              <div class="fail-said">You said: "${l.said}"</div>
            </div>
            <div class="fail-score">${l.score}%</div>
          </div>`).join('');
      }

      // Suggestions
      const suggestions = buildSuggestions(practiceLog, failed, timerSeconds, seen.size);
      const sugEl = document.getElementById('rep-suggestions');
      sugEl.innerHTML = suggestions.map(s =>
        `<div class="suggestion-item"><span class="suggestion-icon">${s.icon}</span><span>${s.text}</span></div>`
      ).join('');

      modal.classList.remove('hidden');
    }

    function buildSuggestions(log, failed, seconds, cardsSeen) {
      const tips = [];
      const attempts = log.length;
      const avgScore = attempts > 0 ? Math.round(log.reduce((a,b) => a+b.score, 0) / attempts) : null;

      if (attempts === 0) {
        tips.push({ icon: '🎤', text: 'No usaste el micrófono en esta sesión. ¡Intenta pronunciar cada frase en voz alta — es clave para mejorar!' });
      }

      if (avgScore !== null && avgScore < 50) {
        tips.push({ icon: '🔊', text: 'Tu score promedio es bajo. Primero escucha la frase con el botón 🔊 varias veces antes de intentar pronunciarla.' });
      }

      if (avgScore !== null && avgScore >= 80) {
        tips.push({ icon: '🏆', text: '¡Excelente pronunciación en esta sesión! Sigue así y pronto sonarás como un nativo.' });
      }

      if (failed.length > 0) {
        const worstPhrase = failed.reduce((a,b) => a.score < b.score ? a : b);
        tips.push({ icon: '🎯', text: `Enfócate en: "<strong>${worstPhrase.phrase}</strong>" — fue tu frase más difícil (${worstPhrase.score}%). Repítela al menos 5 veces.` });
      }

      if (failed.length >= 3) {
        tips.push({ icon: '📝', text: `Tuviste ${failed.length} frases con score menor al 70%. Practica estas frases específicas al inicio de tu próxima sesión.` });
      }

      if (seconds < 120 && attempts > 0) {
        tips.push({ icon: '⏱️', text: 'Sesión muy corta. Intenta practicar al menos 10 minutos seguidos para ver resultados más rápido.' });
      }

      if (seconds >= 600) {
        tips.push({ icon: '💪', text: `¡Dedicaste ${formatTimeShort(seconds)} de práctica! La constancia es lo que marca la diferencia.` });
      }

      if (cardsSeen > 0 && attempts === 0) {
        tips.push({ icon: '🎤', text: 'Viste varias tarjetas pero no practicaste pronunciación. ¡Usa el botón del micrófono en cada tarjeta!' });
      }

      if (attempts > 0 && log.filter(l => l.score === 100).length / attempts >= 0.5) {
        tips.push({ icon: '🚀', text: 'Más del 50% de tus intentos fueron perfectos. ¡Estás listo para frases más avanzadas!' });
      }

      if (tips.length === 0) {
        tips.push({ icon: '✨', text: 'Sigue practicando todos los días. La consistencia es más importante que la duración de cada sesión.' });
      }

      return tips;
    }

    function closeReport() {
      document.getElementById('report-modal').classList.add('hidden');
    }

    // ── Dashboard de progreso ─────────────────────────────────────
    function showProgressDashboard() {
      if (!currentUser) return;
      const total     = allPhrases.length;
      let mastered    = 0, practicing = 0;
      allPhrases.forEach(p => {
        const st = progressMap.get(p.id)?.status;
        if (st === 'mastered') mastered++;
        else if (st === 'practicing' || progressMap.has(p.id)) practicing++;
      });
      const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;

      document.getElementById('prog-subtitle').textContent =
        `Has dominado ${mastered} de ${total} frases`;

      // Círculo de avance
      const cls = pct >= 70 ? 'score-circle-great' : pct >= 30 ? 'score-circle-good' : 'score-circle-try';
      document.getElementById('prog-circle-wrap').innerHTML = `
        <div class="score-circle ${cls}">
          <span>${pct}%</span>
          <span class="score-circle-label">DOMINADO</span>
        </div>`;

      document.getElementById('prog-mastered').textContent   = mastered;
      document.getElementById('prog-practicing').textContent = practicing;
      document.getElementById('prog-total').textContent      = total;

      // Progreso por categoría
      const byCat = {};
      allPhrases.forEach(p => {
        const c = p.category || 'Sin categoría';
        if (!byCat[c]) byCat[c] = { total: 0, mastered: 0 };
        byCat[c].total++;
        if (progressMap.get(p.id)?.status === 'mastered') byCat[c].mastered++;
      });
      const cats = Object.entries(byCat).sort((a, b) => b[1].total - a[1].total);
      document.getElementById('prog-categories').innerHTML = cats.map(([name, d]) => {
        const cp = d.total > 0 ? Math.round((d.mastered / d.total) * 100) : 0;
        return `
          <div class="prog-cat-row">
            <div class="prog-cat-head">
              <span class="prog-cat-name">${name}</span>
              <span class="prog-cat-val">${d.mastered}/${d.total}</span>
            </div>
            <div class="prog-cat-bar"><div class="prog-cat-fill" style="width:${cp}%"></div></div>
          </div>`;
      }).join('');

      // Racha + calendario
      renderStreakDashboard();

      document.getElementById('progress-modal').classList.remove('hidden');
    }

    function renderStreakDashboard() {
      const { current, best, totalActive } = computeStreaks();
      document.getElementById('prog-streak-cur').textContent   = current;
      document.getElementById('prog-streak-best').textContent  = best;
      document.getElementById('prog-streak-total').textContent = totalActive;

      // Calendario de los últimos 14 días
      const byDay = {};
      activityDays.forEach(a => { byDay[a.day] = a; });
      const cells = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = todayStr(d);
        const rec = byDay[ds];
        let cls = 'cal-cell';
        if (rec && rec.goal_met) cls += ' met';
        else if (rec && rec.count > 0) cls += ' some';
        if (i === 0) cls += ' today';
        cells.push(`<div class="${cls}" title="${ds}${rec ? ' · ' + rec.count + ' frases' : ''}">${d.getDate()}</div>`);
      }
      document.getElementById('prog-calendar').innerHTML = cells.join('');
    }

    function closeProgressDashboard() {
      document.getElementById('progress-modal').classList.add('hidden');
    }

    // ── Load phrases (filter cache + shuffle) ─────────────────────
    function loadPhrases() {
      let filtered;
      if (activeConcept != null) {
        // Filtro por concepto U8: solo phrases mapeadas a activeConcept
        const ids = new Set((LC.contentByConcept.get(activeConcept)?.phrases) || []);
        filtered = allPhrases.filter(p => ids.has(p.id));
      } else if (activeCategory && activeCategory !== 'all') {
        filtered = allPhrases.filter(p => p.category === activeCategory);
      } else {
        filtered = allPhrases;
      }
      phrases = shuffle(filtered);
      document.getElementById('main-content').classList.remove('hidden');
      document.getElementById('main-content').classList.add('fade-in');
      showCard(0);
    }

    // ── Cargar las frases + progreso y arrancar la app ────────────
    async function loadAppData() {
      try {
        if (allPhrases.length === 0) allPhrases = await fetchAllPhrases();
        await loadProgress();
        await loadStreak();
        await loadSrs();
        // Learning Core · MVP progress: hidratar mastery/weakness al arrancar la sesión
        if (LC.enabled) {
          await LC.refreshCoreData().catch(e => console.warn('LC.refreshCoreData:', e));
          renderSidebarLCProgress();
          checkNewBadges(true); // init silencioso: marca logros ya cumplidos sin toast
          maybeShowLCOnboarding();
        }
        document.getElementById('loading').classList.add('hidden');
        loadCategories();
        loadPhrases();
        // Los usuarios con sesión aterrizan en su plan del día
        if (currentUser) {
          switchView('today', document.querySelector('[data-view="today"]'));
        }
      } catch(e) {
        document.getElementById('loading').classList.add('hidden');
        const box = document.getElementById('error-box');
        box.textContent = 'Error conectando a Supabase: ' + e.message;
        box.classList.remove('hidden');
      }
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  AUTENTICACIÓN                                            ║
    // ╚══════════════════════════════════════════════════════════╝
    let authMode = 'login';  // 'login' | 'signup'

    async function init() {
      // ¿Hay sesión activa? (ej. regreso de Google, o sesión guardada)
      const { data: { session } } = await sb.auth.getSession();
      if (session && session.user) {
        currentUser = session.user;
        enterApp();
      } else {
        // Mostrar pantalla de login
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('auth-overlay').style.display = 'flex';
      }

      // Reaccionar a cambios de sesión (login con Google redirige y vuelve)
      sb.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session && session.user) {
          if (!currentUser || currentUser.id !== session.user.id) {
            currentUser = session.user;
            enterApp();
          }
        }
      });
    }

    function enterApp() {
      document.getElementById('auth-overlay').style.display = 'none';
      // Pie del sidebar (usuario)
      if (currentUser) {
        const email = currentUser.email || 'Usuario';
        document.getElementById('user-email').textContent  = email;
        document.getElementById('user-avatar').textContent = email[0].toUpperCase();
        document.getElementById('btn-progress').style.display = '';
      } else {
        document.getElementById('user-email').textContent  = 'Invitado';
        document.getElementById('user-avatar').textContent = '?';
        document.getElementById('sidebar-streak').textContent = 'Sin cuenta';
        document.getElementById('btn-progress').style.display = 'none';
      }
      document.getElementById('sidebar').classList.remove('hidden');
      document.getElementById('hamburger').classList.remove('hidden');
      document.getElementById('fab-add').classList.toggle('hidden', !currentUser);
      loadAppData();
    }

    // ── Sidebar (drawer en móvil) ─────────────────────────────────
    function toggleSidebar() {
      const open = document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebar-scrim').classList.toggle('show', open);
    }
    function closeSidebar() {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebar-scrim').classList.remove('show');
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  NAVEGACIÓN: Tarjetas / Gramática / Verbos               ║
    // ╚══════════════════════════════════════════════════════════╝
    function switchView(name, el) {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      // Marca activo el botón del sidebar aunque se llame por código
      if (el && el.classList.contains('nav-tab')) el.classList.add('active');
      else { const b = document.querySelector('.nav-tab[data-view="' + name + '"]'); if (b) b.classList.add('active'); }
      closeSidebar();
      const isCards = name === 'flashcards';
      // Vista tarjetas
      document.getElementById('category-bar').classList.toggle('hidden', !isCards || allPhrases.length === 0);
      document.getElementById('main-content').classList.toggle('hidden', !isCards);
      document.getElementById('completed').classList.add('hidden');
      // Vistas de estudio
      document.getElementById('view-grammar').classList.toggle('hidden', name !== 'grammar');
      document.getElementById('view-verbs').classList.toggle('hidden', name !== 'verbs');
      document.getElementById('view-linkers').classList.toggle('hidden', name !== 'linkers');
      document.getElementById('view-shadow').classList.toggle('hidden', name !== 'shadow');
      document.getElementById('view-today').classList.toggle('hidden', name !== 'today');
      document.getElementById('view-lab').classList.toggle('hidden', name !== 'lab');
      document.getElementById('view-chat').classList.toggle('hidden', name !== 'chat');
      document.getElementById('view-dict').classList.toggle('hidden', name !== 'dict');
      if (name !== 'shadow') stopShadowMic();
      if (name !== 'lab')    stopLabMic();
      if (name !== 'chat')   stopChatMic();
      if (name !== 'dict')   stopDictMic();
      if (name === 'grammar') loadGrammar();
      if (name === 'verbs')   loadVerbs();
      if (name === 'linkers') loadLinkers();
      if (name === 'shadow')  loadShadow();
      if (name === 'today')   renderToday();
      if (name === 'lab')     loadLab();
      if (name === 'chat')    loadChat();
      if (name === 'dict')    setTimeout(() => document.getElementById('dict-input').focus(), 100);
      // El "+" (agregar frase) solo donde las frases son relevantes
      const fabViews = ['today', 'flashcards', 'shadow'];
      document.getElementById('fab-add').classList.toggle('hidden', !currentUser || !fabViews.includes(name));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Voz genérica en inglés (para gramática y verbos)
    async function speakEnglish(text, btn) {
      if (!('speechSynthesis' in window) || !text) return;
      window.speechSynthesis.cancel();
      if (!cachedEngVoice) cachedEngVoice = await getEnglishVoice();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.9; u.pitch = 1;
      if (cachedEngVoice) u.voice = cachedEngVoice;
      if (btn) {
        u.onstart = () => btn.classList.add('speaking');
        u.onend   = () => btn.classList.remove('speaking');
        u.onerror = () => btn.classList.remove('speaking');
      }
      window.speechSynthesis.speak(u);
    }

    // ── Gramática ─────────────────────────────────────────────────
    let grammarData = null, activeGrammarCat = 'all';

    async function loadGrammar() {
      if (grammarData) return;
      const { data, error } = await sb.from('grammar_topics').select('*').order('sort_order');
      if (error) {
        document.getElementById('grammar-content').innerHTML =
          '<div class="no-data">No pude cargar la gramática. ¿Ya corriste el SQL de <b>grammar_topics</b>?<br><span style="font-size:0.75rem">' + error.message + '</span></div>';
        return;
      }
      grammarData = data || [];
      await loadGrammarProgress();
      // Pills de categoría
      const cats = [...new Set(grammarData.map(g => g.category))];
      const pills = ['<div class="cat-chip active" data-gcat="all" onclick="filterGrammar(\'all\', this)">Todo</div>']
        .concat(cats.map(c => `<div class="cat-chip" data-gcat="${c}" onclick="filterGrammar('${c.replace(/'/g,"\\'")}', this)">${c}</div>`));
      document.getElementById('grammar-cats').innerHTML = pills.join('');
      renderGrammar();
    }

    function filterGrammar(cat, el) {
      activeGrammarCat = cat;
      document.querySelectorAll('#grammar-cats .cat-chip').forEach(c => c.classList.remove('active'));
      if (el) el.classList.add('active');
      renderGrammar();
    }

    function renderGrammar() {
      const list = activeGrammarCat === 'all'
        ? grammarData
        : grammarData.filter(g => g.category === activeGrammarCat);
      let html = '', lastCat = null;
      const spk = t => (t || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      list.forEach(g => {
        if (g.category !== lastCat) { html += `<div class="gram-cat-title">${g.category}</div>`; lastCat = g.category; }
        const audioBtn = txt => `
          <button class="gram-audio" onclick="speakEnglish('${spk(txt)}', this)" title="Escuchar">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          </button>`;

        if (g.kind === 'question') {
          // Tarjeta de PREGUNTA
          html += `
            <div class="gram-card">
              <div class="gram-example" style="margin-bottom:0.35rem">
                ${audioBtn(g.title)}
                <span class="gram-title" style="margin:0">${g.title}</span>
              </div>
              <div class="gram-es">${g.title_es || ''}</div>
              ${g.structure ? `<div class="gram-formula">${g.structure}</div>` : ''}
              ${g.answer_en ? `
                <div class="gram-example" style="margin-top:0.4rem">
                  ${audioBtn(g.answer_en)}
                  <span class="gram-en">${g.answer_en}</span>
                </div>
                <div class="gram-es">${g.answer_es || ''}</div>` : ''}
              ${g.usage ? `<div class="gram-usage">💡 ${g.usage}</div>` : ''}
            </div>`;
        } else {
          // Tarjeta de TEMA gramatical
          html += `
            <div class="gram-card">
              <div class="gram-title">${g.title}</div>
              ${g.structure ? `<div class="gram-formula">${g.structure}</div>` : ''}
              <div class="gram-example">
                ${audioBtn(g.example_en)}
                <span class="gram-en">${g.example_en || ''}</span>
              </div>
              <div class="gram-es">${g.example_es || ''}</div>
              ${g.usage ? `<div class="gram-usage">💡 ${g.usage}</div>` : ''}
            </div>`;
        }
      });
      document.getElementById('grammar-content').innerHTML = html || '<div class="no-data">Sin contenido.</div>';
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  PRÁCTICA de preguntas (dentro de Gramática)             ║
    // ╚══════════════════════════════════════════════════════════╝
    const GQUIZ_SIZE = 10;
    let gquiz = [], gquizIndex = 0, gquizScore = 0, gquizAnswered = false, gquizMissed = [];
    let grammarProgress = new Map();

    function setGrammarMode(mode) {
      ['study', 'quiz', 'stats'].forEach(m =>
        document.getElementById('gmode-' + m).classList.toggle('active', m === mode));
      document.getElementById('grammar-study').classList.toggle('hidden', mode !== 'study');
      document.getElementById('grammar-quiz').classList.toggle('hidden',  mode !== 'quiz');
      document.getElementById('grammar-stats').classList.toggle('hidden', mode !== 'stats');
      if (mode !== 'quiz') stopQuestionMic();
      if (mode === 'quiz')  startGrammarQuiz();
      if (mode === 'stats') renderGrammarStats();
    }

    // ── Progreso ──────────────────────────────────────────────────
    async function loadGrammarProgress() {
      grammarProgress = new Map();
      if (!currentUser) return;
      const { data, error } = await sb.from('grammar_progress').select('topic_id,attempts,correct,last_result');
      if (error) { console.warn('grammar_progress:', error.message); return; }
      (data || []).forEach(r => grammarProgress.set(r.topic_id, {
        attempts: r.attempts, correct: r.correct, last_result: r.last_result
      }));
    }

    async function saveGrammarAnswer(topicId, wasCorrect) {
      if (!currentUser) return;
      const prev = grammarProgress.get(topicId) || { attempts: 0, correct: 0 };
      const row = {
        user_id: currentUser.id, topic_id: topicId,
        attempts: prev.attempts + 1,
        correct:  prev.correct + (wasCorrect ? 1 : 0),
        last_result: wasCorrect,
        last_practiced: new Date().toISOString()
      };
      grammarProgress.set(topicId, { attempts: row.attempts, correct: row.correct, last_result: wasCorrect });
      const { error } = await sb.from('grammar_progress').upsert(row, { onConflict: 'user_id,topic_id' });
      if (error) console.warn('saveGrammarAnswer:', error.message);
    }

    function grammarStats() {
      const rows = [];
      (grammarData || []).filter(g => g.kind === 'question').forEach(g => {
        const p = grammarProgress.get(g.id);
        if (p && p.attempts > 0) rows.push({ topic: g, ...p, acc: p.correct / p.attempts });
      });
      const totalAttempts = rows.reduce((a, b) => a + b.attempts, 0);
      const totalCorrect  = rows.reduce((a, b) => a + b.correct, 0);
      const weak   = rows.filter(r => r.acc < 0.7).sort((a, b) => a.acc - b.acc);
      const strong = rows.filter(r => r.acc >= 0.8 && r.attempts >= 2).sort((a, b) => b.acc - a.acc);
      return { rows, practiced: rows.length, totalAttempts, totalCorrect, weak, strong };
    }

    // ── Auxiliares para el tipo "completa el auxiliar" ────────────
    const AUXES = ['do','does','did','am','is','are','was','were','have','has','had','will','would','can','could','should','may','might'];
    const AUX_FAM = {
      do:['does','did','are'], does:['do','did','is'], did:['do','does','was'],
      am:['is','are','do'], is:['are','am','was'], are:['is','am','were'],
      was:['were','is','did'], were:['was','are','did'],
      have:['has','had','do'], has:['have','had','does'], had:['have','has','did'],
      will:['would','can','do'], would:['will','could','do'],
      can:['could','will','do'], could:['can','would','did'],
      should:['would','could','can'], may:['might','can','could'], might:['may','could','can']
    };

    function findAux(text) {
      const re = new RegExp('\\b(' + AUXES.join('|') + ')\\b', 'i');
      const m = text.match(re);
      return m ? { word: m[0], clean: m[0].toLowerCase(), index: m.index } : null;
    }

    function buildGrammarQuestion(t, pool) {
      const aux = findAux(t.title);
      const types = [];
      if (aux)         types.push('aux', 'aux');
      if (t.answer_en) types.push('match');
      types.push('speak');
      const type = types[Math.floor(Math.random() * types.length)];

      if (type === 'aux') {
        const before = t.title.slice(0, aux.index);
        const after  = t.title.slice(aux.index + aux.word.length);
        const fam    = AUX_FAM[aux.clean] || ['do','is','have'];
        const opts   = [aux.clean];
        fam.forEach(f => { if (opts.length < 4 && !opts.includes(f)) opts.push(f); });
        let g = 0;
        while (opts.length < 4 && g++ < 50) {
          const r = AUXES[Math.floor(Math.random() * AUXES.length)];
          if (!opts.includes(r)) opts.push(r);
        }
        const options = shuffle(opts);
        return { topic: t, type, tag: '🧩 Completa el auxiliar',
                 promptHtml: `${before}<span class="quiz-blank">_____</span>${after}`,
                 hint: t.title_es || '', options, answer: options.indexOf(aux.clean) };
      }

      if (type === 'match') {
        const others = shuffle(pool.filter(x => x.id !== t.id && x.title !== t.title)).slice(0, 3);
        const options = shuffle([t.title, ...others.map(o => o.title)]);
        return { topic: t, type, tag: '💬 ¿Qué pregunta encaja?',
                 promptHtml: `<span style="font-size:0.95rem;color:var(--text-muted)">Alguien responde:</span><br>“${t.answer_en}”`,
                 hint: t.answer_es || '', options, answer: options.indexOf(t.title) };
      }

      return { topic: t, type: 'speak', tag: '🎤 Dilo en voz alta',
               promptHtml: `${t.title_es || t.title}`,
               hint: 'Di esta pregunta en inglés', options: [], answer: -1 };
    }

    function startGrammarQuiz(weakOnly, explicitPool) {
      if (!grammarData) return;
      const questions = grammarData.filter(g => g.kind === 'question');
      let base;
      if (explicitPool) {
        base = explicitPool;
      } else if (weakOnly === true) {
        const weakIds = new Set(grammarStats().weak.map(w => w.topic.id));
        base = questions.filter(g => weakIds.has(g.id));
      } else {
        base = (activeGrammarCat === 'all')
          ? questions
          : questions.filter(g => g.category === activeGrammarCat);
        if (base.length < 4) base = questions;   // si la categoría no es de preguntas, usa todas
      }
      const msg = document.getElementById('gquiz-msg');
      if (base.length < (explicitPool ? 1 : 4)) {
        msg.innerHTML = weakOnly === true
          ? '<div class="no-data">Aún no tienes preguntas por reforzar. ¡Practica un poco más! 💪</div>'
          : '<div class="no-data">No pude cargar el banco de preguntas. ¿Ya corriste el SQL de <b>preguntas</b>?</div>';
        document.getElementById('gquiz-play').classList.add('hidden');
        document.getElementById('gquiz-result').classList.add('hidden');
        return;
      }
      msg.innerHTML = '';
      gquizMissed = [];
      const chosen = shuffle(base).slice(0, Math.min(GQUIZ_SIZE, base.length));
      gquiz = chosen.map(t => buildGrammarQuestion(t, questions));
      gquizIndex = 0; gquizScore = 0;
      document.getElementById('gquiz-result').classList.add('hidden');
      document.getElementById('gquiz-play').classList.remove('hidden');
      renderGrammarQuestion();
    }

    function renderGrammarQuestion() {
      gquizAnswered = false;
      stopQuestionMic();
      const q = gquiz[gquizIndex];
      document.getElementById('gquiz-progress').textContent = `Pregunta ${gquizIndex + 1} de ${gquiz.length}`;
      document.getElementById('gquiz-score').textContent    = gquizScore;
      document.getElementById('gquiz-bar-fill').style.width = (gquizIndex / gquiz.length * 100) + '%';
      document.getElementById('gquiz-type').textContent     = q.tag;
      document.getElementById('gquiz-prompt').innerHTML     = q.promptHtml;
      document.getElementById('gquiz-hint').textContent     = q.hint || '';

      const isSpeak = q.type === 'speak';
      document.getElementById('gquiz-options').classList.toggle('hidden', isSpeak);
      document.getElementById('gquiz-speak').classList.toggle('hidden', !isSpeak);
      document.getElementById('gquiz-options').innerHTML = isSpeak ? '' :
        q.options.map((o, i) => `<button class="quiz-opt" id="gqopt-${i}" onclick="answerGrammarQuiz(${i})">${o}</button>`).join('');
      if (isSpeak) document.getElementById('gquiz-speak-hint').textContent = 'Oprime el micrófono y di la pregunta en inglés';

      const fb = document.getElementById('gquiz-feedback');
      fb.classList.add('hidden'); fb.innerHTML = '';
      document.getElementById('gquiz-next').classList.add('hidden');
    }

    function answerGrammarQuiz(i) {
      if (gquizAnswered) return;
      const q = gquiz[gquizIndex];
      q.options.forEach((o, idx) => {
        const btn = document.getElementById('gqopt-' + idx);
        if (idx === q.answer)  btn.classList.add('ok');
        else if (idx === i)    btn.classList.add('bad');
        btn.disabled = true;
      });
      finishGrammarQuestion(i === q.answer);
    }

    function finishGrammarQuestion(correct, extraHtml) {
      gquizAnswered = true;
      const q = gquiz[gquizIndex];
      const t = q.topic;
      if (correct) gquizScore++;
      else gquizMissed.push(t);
      saveGrammarAnswer(t.id, correct);
      scheduleSrs('question', t.id, correct ? 'good' : 'again');
      // ── Learning Core · dual-write (Fase 2) ──────────────────────
      // Legacy (arriba) ya escribió y es autoritativo. El Core es best-effort:
      // solo si LC.enabled, fire-and-forget (no bloquea la UI), y cualquier
      // error queda aislado en .catch (nunca rompe el flujo legacy).
      if (LC.enabled) {
        LC.submitFromQuestion(t.id, correct, q.type)
          .then(() => lcRefreshAndNotify())
          .catch(e => console.warn('LC dual-write (gramática):', e));
      }

      const fb = document.getElementById('gquiz-feedback');
      fb.className = 'quiz-feedback ' + (correct ? 'good' : 'bad');
      fb.innerHTML = `
        <div class="qfb-title">${correct ? '✅ ¡Correcto!' : '❌ La respuesta era:'}</div>
        ${extraHtml || ''}
        <div class="qfb-en">${t.title}</div>
        <div class="qfb-es">${t.title_es || ''}</div>
        ${t.structure ? `<div class="gram-formula" style="margin:0.5rem 0">${t.structure}</div>` : ''}
        ${t.answer_en ? `<div class="qfb-es" style="margin-bottom:0.4rem">💬 Respuesta: “${t.answer_en}”</div>` : ''}
        ${t.usage ? `<div class="qfb-usage">💡 ${t.usage}</div>` : ''}`;
      fb.classList.remove('hidden');
      document.getElementById('gquiz-score').textContent = gquizScore;
      const next = document.getElementById('gquiz-next');
      next.textContent = (gquizIndex === gquiz.length - 1) ? 'Ver resultado 🏁' : 'Siguiente →';
      next.classList.remove('hidden');
      speakEnglish(t.title);
    }

    function nextGrammarQuestion() {
      stopQuestionMic();
      if (gquizIndex < gquiz.length - 1) { gquizIndex++; renderGrammarQuestion(); }
      else showGrammarQuizResult();
    }

    // ── Micrófono para el tipo "dilo en voz alta" ─────────────────
    let qRecognition = null, qMediaRecorder = null, qChunks = [], qListening = false;

    function toggleQuestionMic() { qListening ? stopQuestionMic() : startQuestionMic(); }

    async function startQuestionMic() {
      if (gquizAnswered) return;
      const q = gquiz[gquizIndex];
      const expected = q.topic.title;
      const btn  = document.getElementById('gquiz-mic');
      const hint = document.getElementById('gquiz-speak-hint');

      if (useCloudSTT()) {
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { hint.textContent = 'No pude acceder al micrófono. Revisa los permisos.'; return; }
        qChunks = [];
        let opts = {};
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
          if (MediaRecorder.isTypeSupported('audio/webm'))     opts = { mimeType: 'audio/webm' };
          else if (MediaRecorder.isTypeSupported('audio/mp4')) opts = { mimeType: 'audio/mp4' };
        }
        try { qMediaRecorder = new MediaRecorder(stream, opts); }
        catch (e) { qMediaRecorder = new MediaRecorder(stream); }
        qMediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) qChunks.push(e.data); };
        qMediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const type = (qChunks[0] && qChunks[0].type) || 'audio/webm';
          const blob = new Blob(qChunks, { type }); qChunks = [];
          if (blob.size < 1200) { hint.textContent = 'No te escuché. Intenta de nuevo 🎤'; return; }
          hint.textContent = '⏳ Transcribiendo...';
          try {
            const ext = type.includes('mp4') ? 'mp4' : 'webm';
            const form = new FormData();
            form.append('file', blob, 'audio.' + ext);
            form.append('language', 'en');
            const { data, error } = await sb.functions.invoke('transcribe', { body: form });
            if (error) throw new Error(error.message);
            const said = (data && data.text ? data.text : '').trim();
            if (!said) { hint.textContent = 'No entendí. Intenta de nuevo 🎤'; return; }
            gradeSpokenQuestion(expected, said);
          } catch (e) { hint.textContent = 'Error: ' + (e.message || e); }
        };
        qMediaRecorder.start();
        qListening = true; btn.classList.add('listening');
        hint.textContent = '🔴 Grabando... oprime otra vez al terminar';
      } else {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { hint.textContent = 'Tu navegador no soporta reconocimiento de voz.'; return; }
        qRecognition = new SR();
        qRecognition.lang = 'en-US'; qRecognition.interimResults = false; qRecognition.maxAlternatives = 3;
        qRecognition.onstart  = () => { qListening = true; btn.classList.add('listening'); hint.textContent = '🔴 Escuchando...'; };
        qRecognition.onresult = (e) => {
          let best = e.results[0][0].transcript, bs = scorePronunciation(expected, best);
          for (let i = 1; i < e.results[0].length; i++) {
            const alt = e.results[0][i].transcript, s = scorePronunciation(expected, alt);
            if (s.pct > bs.pct) { bs = s; best = alt; }
          }
          gradeSpokenQuestion(expected, best);
        };
        qRecognition.onerror = (e) => { if (e.error === 'no-speech') hint.textContent = 'No te escuché 🎤'; stopQuestionMic(); };
        qRecognition.onend   = () => stopQuestionMic();
        qRecognition.start();
      }
    }

    function stopQuestionMic() {
      qListening = false;
      const btn = document.getElementById('gquiz-mic');
      if (btn) btn.classList.remove('listening');
      if (qRecognition)   { try { qRecognition.stop(); } catch (e) {} qRecognition = null; }
      if (qMediaRecorder && qMediaRecorder.state !== 'inactive') { try { qMediaRecorder.stop(); } catch (e) {} }
    }

    function gradeSpokenQuestion(expected, said) {
      stopQuestionMic();
      if (gquizAnswered) return;
      const score = scorePronunciation(expected, said);
      const ok = score.pct >= 70;
      document.getElementById('gquiz-speak-hint').textContent = ok ? '✅ ¡Bien dicho!' : 'Sigue practicando 💪';
      const chips = score.wordResult.map(w =>
        `<span class="word-chip ${w.ok ? 'word-ok' : 'word-miss'}">${w.word}</span>`).join('');
      finishGrammarQuestion(ok, `
        <div style="margin-bottom:0.5rem">
          <div class="word-row">${chips}</div>
          <div class="qfb-es">Dijiste: “${said}” · <b>${score.pct}%</b></div>
        </div>`);
    }

    function showGrammarQuizResult() {
      document.getElementById('gquiz-play').classList.add('hidden');
      const pct = Math.round(gquizScore / gquiz.length * 100);
      const cls = pct >= 80 ? 'score-circle-great' : pct >= 50 ? 'score-circle-good' : 'score-circle-try';
      const msg = pct === 100 ? '🏆 ¡Perfecto! Ya formulas preguntas como un pro.'
                : pct >= 80   ? '🎉 ¡Muy bien! Vas por buen camino.'
                : pct >= 50   ? '💪 Buen intento. Repasa las que fallaste.'
                :               '📖 Vuelve al modo Estudiar y luego inténtalo de nuevo.';
      const missHtml = gquizMissed.length ? `
        <div class="miss-box">
          <div class="miss-title">📌 Para reforzar de esta ronda</div>
          ${gquizMissed.map(t => `<div class="miss-item"><b>${t.title}</b> — ${t.title_es || ''}</div>`).join('')}
        </div>` : '';
      const saveNote = currentUser ? '' :
        '<div class="quiz-res-msg" style="color:#fbbf24">💡 Inicia sesión para guardar tu progreso.</div>';

      document.getElementById('gquiz-result').innerHTML = `
        <div class="score-circle ${cls}"><span>${pct}%</span><span class="score-circle-label">ACIERTOS</span></div>
        <div class="quiz-res-txt">${gquizScore} de ${gquiz.length} correctas</div>
        <div class="quiz-res-msg">${msg}</div>
        ${missHtml}${saveNote}
        <button class="btn btn-primary" style="width:100%; justify-content:center; margin-bottom:0.6rem;" onclick="startGrammarQuiz()">🔄 Practicar de nuevo</button>
        ${currentUser ? '<button class="btn btn-secondary" style="width:100%; justify-content:center; margin-bottom:0.6rem;" onclick="setGrammarMode(\'stats\')">📊 Ver mi progreso</button>' : ''}
        <button class="btn btn-secondary" style="width:100%; justify-content:center;" onclick="setGrammarMode('study')">📖 Volver a estudiar</button>`;
      document.getElementById('gquiz-result').classList.remove('hidden');
    }

    function practiceWeakGrammar() { setGrammarMode('quiz'); startGrammarQuiz(true); }

    // Panel de progreso ACCIÓN-PRIMERO, compartido por conectores/verbos/preguntas
    function renderProgressPanel(boxId, s, cfg) {
      const box = document.getElementById(boxId);
      if (!currentUser) { box.innerHTML = '<div class="no-data">🔐 Inicia sesión para guardar y ver tu progreso.</div>'; return; }
      if (!cfg.dataReady) { box.innerHTML = '<div class="no-data">Cargando...</div>'; return; }
      if (s.practiced === 0) { box.innerHTML = '<div class="no-data">' + cfg.emptyMsg + '</div>'; return; }

      const acc = s.totalAttempts ? Math.round(s.totalCorrect / s.totalAttempts * 100) : 0;
      const accColor = acc >= 80 ? '#10b981' : acc >= 50 ? '#fbbf24' : '#f87171';
      const row = (r, kind) => `
        <div class="lp-row ${kind}">
          <span class="lp-word">${cfg.wordOf(r)}</span>
          <span class="lp-tr">${cfg.subOf(r)}</span>
          <span class="lp-acc">${Math.round(r.acc * 100)}%</span>
          <span class="lp-hits">${r.correct}/${r.attempts}</span>
        </div>`;

      let html = '';
      // 1) LA ACCIÓN, primero y prominente
      if (s.weak.length) {
        const n = s.weak.length;
        html += `
          <div class="prog-action-card">
            <div class="prog-action-title">🎯 Necesitas practicar</div>
            ${s.weak.slice(0, 6).map(r => row(r, 'weak')).join('')}
            ${n > 6 ? `<div class="prog-more">…y ${n - 6} más</div>` : ''}
            <button class="btn btn-primary prog-cta" onclick="${cfg.onPractice}">
              ▶ Practicar ${n === 1 ? 'esta' : 'estas ' + n} →
            </button>
          </div>`;
      } else {
        html += `
          <div class="prog-action-card prog-allgood">
            <div class="prog-allgood-icon">🎉</div>
            <div class="prog-action-title">¡Vas al día!</div>
            <p>No tienes ${cfg.unit} por reforzar. Sigue practicando para mantenerlo así.</p>
          </div>`;
      }

      // 2) Los números, secundarios
      html += `
        <div class="lp-summary">
          <div class="lp-card"><div class="lp-num" style="color:${accColor}">${acc}%</div><div class="lp-label">Precisión</div></div>
          <div class="lp-card"><div class="lp-num" style="color:#10b981">${s.strong.length}</div><div class="lp-label">Dominados</div></div>
          <div class="lp-card"><div class="lp-num" style="color:#a855f7">${s.practiced}</div><div class="lp-label">Practicados</div></div>
        </div>`;

      // 3) Los que ya dominas
      if (s.strong.length) {
        html += '<div class="lp-section-title">🟢 Ya los dominas</div>'
          + s.strong.slice(0, 20).map(r => row(r, 'strong')).join('');
      }

      html += `<button class="btn btn-secondary" style="width:100%; justify-content:center; margin-top:1.25rem;" onclick="${cfg.onQuiz}">🎯 Hacer otro quiz</button>`;
      box.innerHTML = html;
    }

    function renderGrammarStats() {
      renderProgressPanel('grammar-stats', grammarStats(), {
        dataReady: !!grammarData,
        emptyMsg: 'Todavía no has practicado preguntas.<br>Ve a <b>🎯 Practicar</b> y haz tu primer quiz.',
        unit: 'preguntas',
        wordOf: r => r.topic.title,
        subOf:  r => r.topic.title_es || '',
        onPractice: 'practiceWeakGrammar()',
        onQuiz: "setGrammarMode('quiz')",
      });
    }

    // ── Verbos irregulares ────────────────────────────────────────
    let verbsData = null;

    let activeVerbType = 'all';
    const VERB_TYPES = [
      ['all', 'Todos'], ['AAA', 'A-A-A'], ['ABA', 'A-B-A'], ['ABB', 'A-B-B'], ['ABC', 'A-B-C']
    ];
    const VERB_TYPE_DESC = {
      AAA: 'invariables', ABA: 'base = participio', ABB: 'pasado = participio', ABC: 'las 3 distintas'
    };

    async function loadVerbs() {
      if (verbsData) return;
      const { data, error } = await sb.from('irregular_verbs').select('*').order('sort_order');
      if (error) {
        document.getElementById('verb-table').innerHTML =
          '<div class="no-data">No pude cargar los verbos. ¿Ya corriste el SQL de <b>irregular_verbs</b>?<br><span style="font-size:0.75rem">' + error.message + '</span></div>';
        return;
      }
      verbsData = data || [];
      await loadVerbProgress();
      buildVerbTypePills();
      renderVerbConceptChips();
      renderVerbs();
    }

    // Iter A.7 · chips concepto U14 en la sección Verbos
    let activeVerbConcept = null;
    function renderVerbConceptChips() {
      const bar = document.getElementById('verb-concept-chips');
      if (!bar) return;
      if (!LC.enabled || LC.contentByConcept.size === 0) { bar.innerHTML = ''; return; }
      const chips = LC_U14_IDS
        .map(cid => ({ cid, count: (LC.contentByConcept.get(cid)?.verbs || []).length }))
        .filter(c => c.count > 0);
      if (chips.length === 0) { bar.innerHTML = ''; return; }
      bar.innerHTML = chips.map(c => {
        const name = LC_SHORT_NAMES[c.cid] || LC.conceptNames.get(c.cid)?.name || ('C' + c.cid);
        const active = activeVerbConcept === c.cid ? ' active' : '';
        return `<div class="cat-chip cat-chip-concept${active}" onclick="selectVerbConcept(${c.cid}, this)">
                  ✨ ${escapeHtml(name)} <span class="cat-count">${c.count}</span>
                </div>`;
      }).join('');
    }
    function selectVerbConcept(cid, el) {
      activeVerbConcept = cid;
      // reset legacy pill al 'Todos' visualmente
      activeVerbType = 'all';
      document.querySelectorAll('#verb-types .cat-chip').forEach(c => c.classList.remove('active'));
      const allChip = document.querySelector('#verb-types [data-vt="all"]');
      if (allChip) allChip.classList.add('active');
      // visual chip concepto activo
      document.querySelectorAll('#verb-concept-chips .cat-chip-concept').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      renderVerbs();
    }

    function buildVerbTypePills() {
      const el = document.getElementById('verb-types');
      if (!el) return;
      // Iter A.7.1: si LC.enabled y hay chips concepto U14 disponibles, se ocultan
      // los 4 sub-tipos legacy (A-A-A/A-B-A/A-B-B/A-B-C) porque son 1:1 con los chips
      // morados. Se conserva solo "Todos". Guest ve la barra legacy completa.
      const hasCoreChips = LC.enabled && LC.contentByConcept.size > 0 &&
        LC_U14_IDS.some(cid => (LC.contentByConcept.get(cid)?.verbs || []).length > 0);
      const types = hasCoreChips ? [['all', 'Todos']] : VERB_TYPES;
      el.innerHTML = types.map(([t, label]) => {
        const n = t === 'all' ? verbsData.length : verbsData.filter(v => v.pattern_type === t).length;
        return `<div class="cat-chip ${activeVerbType === t ? 'active' : ''}" data-vt="${t}" onclick="filterVerbType('${t}', this)"
                  ${t !== 'all' ? `title="${VERB_TYPE_DESC[t] || ''}"` : ''}>${label} <span class="cat-count">${n}</span></div>`;
      }).join('');
    }

    function filterVerbType(t, el) {
      activeVerbType = t;
      activeVerbConcept = null;  // filtro legacy limpia el filtro concepto
      document.querySelectorAll('#verb-types .cat-chip').forEach(c => c.classList.remove('active'));
      if (el) el.classList.add('active');
      document.querySelectorAll('#verb-concept-chips .cat-chip-concept').forEach(c => c.classList.remove('active'));
      renderVerbs();
    }

    function renderVerbs() {
      if (!verbsData) return;
      const q = (document.getElementById('verb-search').value || '').toLowerCase().trim();
      let list = verbsData;
      if (activeVerbConcept != null) {
        const ids = new Set((LC.contentByConcept.get(activeVerbConcept)?.verbs) || []);
        list = list.filter(v => ids.has(v.id));
      } else if (activeVerbType !== 'all') {
        list = list.filter(v => v.pattern_type === activeVerbType);
      }
      if (q) list = list.filter(v =>
        v.infinitive.toLowerCase().includes(q) ||
        v.past_simple.toLowerCase().includes(q) ||
        v.past_participle.toLowerCase().includes(q) ||
        (v.translation || '').toLowerCase().includes(q));

      document.getElementById('verb-count').textContent = `${list.length} verbo${list.length === 1 ? '' : 's'}`;

      const ipa = t => t ? `<small class="vf-ipa">${t}</small>` : '';
      let html = '', lastPattern = ' ';
      list.forEach(v => {
        const pat = v.pattern || 'Sin clasificar';
        if (pat !== lastPattern) { html += `<div class="verb-pattern-title">${pat}</div>`; lastPattern = pat; }
        const say = `${v.infinitive}, ${v.past_simple.replace(/\s*\/\s*/g, ' or ')}, ${v.past_participle.replace(/\s*\/\s*/g, ' or ')}`.replace(/'/g, "\\'");
        html += `
          <div class="verb-row">
            <div class="verb-forms">
              <span class="vf base">${v.infinitive}${ipa(v.ipa_inf)}</span>
              <span class="vf">${v.past_simple}${ipa(v.ipa_past)}</span>
              <span class="vf">${v.past_participle}${ipa(v.ipa_part)}</span>
            </div>
            <div class="verb-tr">${v.translation}</div>
            <button class="verb-audio" onclick="speakEnglish('${say}', this)" title="Escuchar">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
          </div>`;
      });
      document.getElementById('verb-table').innerHTML = html || '<div class="no-data">No se encontraron verbos.</div>';
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  PRÁCTICA de verbos irregulares                          ║
    // ╚══════════════════════════════════════════════════════════╝
    const VQUIZ_SIZE = 10;
    let vquiz = [], vquizIndex = 0, vquizScore = 0, vquizAnswered = false, vquizMissed = [];
    let verbProgress = new Map();   // verb_id -> { attempts, correct, last_result }

    function setVerbMode(mode) {
      ['study', 'quiz', 'stats'].forEach(m =>
        document.getElementById('vmode-' + m).classList.toggle('active', m === mode));
      document.getElementById('verb-study').classList.toggle('hidden', mode !== 'study');
      document.getElementById('verb-quiz').classList.toggle('hidden',  mode !== 'quiz');
      document.getElementById('verb-stats').classList.toggle('hidden', mode !== 'stats');
      if (mode === 'quiz')  startVerbQuiz();
      if (mode === 'stats') renderVerbStats();
    }

    // ── Progreso ──────────────────────────────────────────────────
    async function loadVerbProgress() {
      verbProgress = new Map();
      if (!currentUser) return;
      const { data, error } = await sb.from('verb_progress').select('verb_id,attempts,correct,last_result');
      if (error) { console.warn('verb_progress:', error.message); return; }
      (data || []).forEach(r => verbProgress.set(r.verb_id, {
        attempts: r.attempts, correct: r.correct, last_result: r.last_result
      }));
    }

    async function saveVerbAnswer(verbId, wasCorrect) {
      if (!currentUser) return;
      const prev = verbProgress.get(verbId) || { attempts: 0, correct: 0 };
      const row = {
        user_id: currentUser.id, verb_id: verbId,
        attempts: prev.attempts + 1,
        correct:  prev.correct + (wasCorrect ? 1 : 0),
        last_result: wasCorrect,
        last_practiced: new Date().toISOString()
      };
      verbProgress.set(verbId, { attempts: row.attempts, correct: row.correct, last_result: wasCorrect });
      const { error } = await sb.from('verb_progress').upsert(row, { onConflict: 'user_id,verb_id' });
      if (error) console.warn('saveVerbAnswer:', error.message);

      // ── Learning Core · hook activo (Batch A · iter A.5) ─────────
      // Ruta evidence-only vía LC.submitFromVerb: resuelve verb → concepto
      // U14 (past-simple-irregular-XXX) y registra outcome. Fire-and-forget.
      if (LC.enabled) {
        LC.submitFromVerb(verbId, wasCorrect)
          .then(() => lcRefreshAndNotify())
          .catch(function(e) { console.warn('LC dual-write (verbos):', e.message); });
      }
    }

    function verbStats() {
      const rows = [];
      (verbsData || []).forEach(v => {
        const p = verbProgress.get(v.id);
        if (p && p.attempts > 0) rows.push({ verb: v, ...p, acc: p.correct / p.attempts });
      });
      const totalAttempts = rows.reduce((a, b) => a + b.attempts, 0);
      const totalCorrect  = rows.reduce((a, b) => a + b.correct, 0);
      const weak   = rows.filter(r => r.acc < 0.7).sort((a, b) => a.acc - b.acc);
      const strong = rows.filter(r => r.acc >= 0.8 && r.attempts >= 2).sort((a, b) => b.acc - a.acc);
      return { rows, practiced: rows.length, totalAttempts, totalCorrect, weak, strong };
    }

    // ── Construcción de preguntas ─────────────────────────────────
    function firstForm(s) { return (s || '').split('/')[0].trim(); }

    // El error típico: conjugar el irregular como si fuera regular (writed, goed...)
    function fakeRegular(base) {
      if (/e$/i.test(base))            return base + 'd';
      if (/[^aeiou]y$/i.test(base))    return base.slice(0, -1) + 'ied';
      return base + 'ed';
    }

    function uniqueOptions(correct, candidates, pool, n = 4) {
      const opts = [correct];
      const has = s => opts.some(o => o.toLowerCase() === String(s).toLowerCase());
      candidates.forEach(c => { if (opts.length < n && c && !has(c)) opts.push(c); });
      let guard = 0;
      while (opts.length < n && guard++ < 300) {
        const r = pool[Math.floor(Math.random() * pool.length)];
        const cand = Math.random() < 0.5 ? r.past_simple : r.past_participle;
        if (cand && !has(cand)) opts.push(cand);
      }
      return shuffle(opts);
    }

    function buildVerbQuestion(v, pool) {
      const base = v.infinitive, past = v.past_simple, part = v.past_participle;
      const pastF = firstForm(past);
      const canSentence = v.example_en && v.example_en.toLowerCase().includes(pastF.toLowerCase());
      const types = canSentence ? ['sentence', 'sentence', 'past', 'participle'] : ['past', 'participle'];
      const type  = types[Math.floor(Math.random() * types.length)];

      let promptHtml, tag, correct;
      if (type === 'sentence') {
        const idx = v.example_en.toLowerCase().indexOf(pastF.toLowerCase());
        const before = v.example_en.slice(0, idx);
        const after  = v.example_en.slice(idx + pastF.length);
        promptHtml = `${before}<span class="quiz-blank">_____</span>${after}`;
        tag = '📝 Completa la frase';
        correct = past;
      } else if (type === 'past') {
        promptHtml = `¿Cuál es el <b style="color:#a855f7">pasado</b> de <b>"${base}"</b>?`;
        tag = '⏪ Pasado simple';
        correct = past;
      } else {
        promptHtml = `¿Cuál es el <b style="color:#a855f7">participio</b> de <b>"${base}"</b>?`;
        tag = '✅ Participio';
        correct = part;
      }
      const distract = [correct === past ? part : past, fakeRegular(base), base];
      const options  = uniqueOptions(correct, distract, pool);
      return { verb: v, type, tag, promptHtml, options, answer: options.findIndex(o => o === correct) };
    }

    function startVerbQuiz(weakOnly, explicitPool) {
      if (!verbsData) return;
      let base;
      if (explicitPool) {
        base = explicitPool;
      } else if (weakOnly === true) {
        const weakIds = new Set(verbStats().weak.map(w => w.verb.id));
        base = verbsData.filter(v => weakIds.has(v.id));
      } else if (activeVerbConcept != null) {
        // Iter A.7: si hay filtro concepto activo, cuenta como pool
        const ids = new Set((LC.contentByConcept.get(activeVerbConcept)?.verbs) || []);
        base = verbsData.filter(v => ids.has(v.id));
      } else {
        const q = (document.getElementById('verb-search').value || '').toLowerCase().trim();
        base = q ? verbsData.filter(v =>
                     v.infinitive.toLowerCase().includes(q) || v.translation.toLowerCase().includes(q))
                 : verbsData;
      }
      const msg = document.getElementById('vquiz-msg');
      const minNeeded = explicitPool ? 1 : 4;
      if (base.length < minNeeded) {
        msg.innerHTML = weakOnly === true
          ? '<div class="no-data">Aún no tienes verbos por reforzar. ¡Practica un poco más primero! 💪</div>'
          : '<div class="no-data">Muy pocos verbos para practicar. Limpia el buscador en el modo Estudiar.</div>';
        document.getElementById('vquiz-play').classList.add('hidden');
        document.getElementById('vquiz-result').classList.add('hidden');
        return;
      }
      msg.innerHTML = '';
      vquizMissed = [];
      const chosen = shuffle(base).slice(0, Math.min(VQUIZ_SIZE, base.length));
      vquiz = chosen.map(v => buildVerbQuestion(v, verbsData));
      vquizIndex = 0; vquizScore = 0;
      document.getElementById('vquiz-result').classList.add('hidden');
      document.getElementById('vquiz-play').classList.remove('hidden');
      renderVerbQuestion();
    }

    function renderVerbQuestion() {
      vquizAnswered = false;
      const q = vquiz[vquizIndex];
      document.getElementById('vquiz-progress').textContent = `Pregunta ${vquizIndex + 1} de ${vquiz.length}`;
      document.getElementById('vquiz-score').textContent    = vquizScore;
      document.getElementById('vquiz-bar-fill').style.width = (vquizIndex / vquiz.length * 100) + '%';
      document.getElementById('vquiz-type').textContent     = q.tag;
      document.getElementById('vquiz-prompt').innerHTML     = q.promptHtml;
      document.getElementById('vquiz-options').innerHTML = q.options.map((o, i) =>
        `<button class="quiz-opt" id="vqopt-${i}" onclick="answerVerbQuiz(${i})">${o}</button>`).join('');
      const fb = document.getElementById('vquiz-feedback');
      fb.classList.add('hidden'); fb.innerHTML = '';
      document.getElementById('vquiz-next').classList.add('hidden');
    }

    function answerVerbQuiz(i) {
      if (vquizAnswered) return;
      vquizAnswered = true;
      const q = vquiz[vquizIndex];
      const correct = i === q.answer;
      if (correct) vquizScore++;
      else vquizMissed.push(q.verb);
      saveVerbAnswer(q.verb.id, correct);
      scheduleSrs('verb', q.verb.id, correct ? 'good' : 'again');
      q.options.forEach((o, idx) => {
        const btn = document.getElementById('vqopt-' + idx);
        if (idx === q.answer)  btn.classList.add('ok');
        else if (idx === i)    btn.classList.add('bad');
        btn.disabled = true;
      });
      const v  = q.verb;
      const fb = document.getElementById('vquiz-feedback');
      fb.className = 'quiz-feedback ' + (correct ? 'good' : 'bad');
      fb.innerHTML = `
        <div class="qfb-title">${correct ? '✅ ¡Correcto!' : '❌ La respuesta era: ' + q.options[q.answer]}</div>
        <div class="vforms">
          <span class="vform${q.type === 'past' || q.type === 'sentence' ? '' : ''}">${v.infinitive}<small>infinitivo</small></span>
          <span class="vform${q.type !== 'participle' ? ' hl' : ''}">${v.past_simple}<small>pasado</small></span>
          <span class="vform${q.type === 'participle' ? ' hl' : ''}">${v.past_participle}<small>participio</small></span>
        </div>
        <div class="qfb-es" style="margin-bottom:0.5rem">${v.translation}</div>
        ${v.example_en ? `<div class="qfb-en">${v.example_en}</div><div class="qfb-es">${v.example_es || ''}</div>` : ''}`;
      fb.classList.remove('hidden');
      document.getElementById('vquiz-score').textContent = vquizScore;
      const next = document.getElementById('vquiz-next');
      next.textContent = (vquizIndex === vquiz.length - 1) ? 'Ver resultado 🏁' : 'Siguiente →';
      next.classList.remove('hidden');
      if (v.example_en) speakEnglish(v.example_en);
      else speakEnglish(`${v.infinitive}, ${firstForm(v.past_simple)}, ${firstForm(v.past_participle)}`);
    }

    function nextVerbQuestion() {
      if (vquizIndex < vquiz.length - 1) { vquizIndex++; renderVerbQuestion(); }
      else showVerbQuizResult();
    }

    function showVerbQuizResult() {
      document.getElementById('vquiz-play').classList.add('hidden');
      const pct = Math.round(vquizScore / vquiz.length * 100);
      const cls = pct >= 80 ? 'score-circle-great' : pct >= 50 ? 'score-circle-good' : 'score-circle-try';
      const msg = pct === 100 ? '🏆 ¡Perfecto! Dominas estos verbos.'
                : pct >= 80   ? '🎉 ¡Muy bien! Casi todos correctos.'
                : pct >= 50   ? '💪 Buen intento. Repasa los que fallaste.'
                :               '📖 Vuelve al modo Estudiar y luego inténtalo de nuevo.';
      const missHtml = vquizMissed.length ? `
        <div class="miss-box">
          <div class="miss-title">📌 Para reforzar de esta ronda</div>
          ${vquizMissed.map(v => `<div class="miss-item"><b>${v.infinitive}</b> → ${v.past_simple} → ${v.past_participle} <span style="color:var(--text-muted)">(${v.translation})</span></div>`).join('')}
        </div>` : '';
      const saveNote = currentUser ? '' :
        '<div class="quiz-res-msg" style="color:#fbbf24">💡 Inicia sesión para guardar tu progreso y saber qué reforzar.</div>';

      document.getElementById('vquiz-result').innerHTML = `
        <div class="score-circle ${cls}"><span>${pct}%</span><span class="score-circle-label">ACIERTOS</span></div>
        <div class="quiz-res-txt">${vquizScore} de ${vquiz.length} correctas</div>
        <div class="quiz-res-msg">${msg}</div>
        ${missHtml}${saveNote}
        <button class="btn btn-primary" style="width:100%; justify-content:center; margin-bottom:0.6rem;" onclick="startVerbQuiz()">🔄 Practicar de nuevo</button>
        ${currentUser ? '<button class="btn btn-secondary" style="width:100%; justify-content:center; margin-bottom:0.6rem;" onclick="setVerbMode(\'stats\')">📊 Ver mi progreso</button>' : ''}
        <button class="btn btn-secondary" style="width:100%; justify-content:center;" onclick="setVerbMode('study')">📖 Volver a estudiar</button>`;
      document.getElementById('vquiz-result').classList.remove('hidden');
    }

    function practiceWeakVerbs() { setVerbMode('quiz'); startVerbQuiz(true); }

    function renderVerbStats() {
      renderProgressPanel('verb-stats', verbStats(), {
        dataReady: !!verbsData,
        emptyMsg: 'Todavía no has practicado verbos.<br>Ve a <b>🎯 Practicar</b> y haz tu primer quiz.',
        unit: 'verbos',
        wordOf: r => r.verb.infinitive,
        subOf:  r => r.verb.past_simple + ' · ' + r.verb.past_participle,
        onPractice: 'practiceWeakVerbs()',
        onQuiz: "setVerbMode('quiz')",
      });
    }

    // ── Conectores (linking words) ─────────────────────────────────
    let linkersData = null, activeLinkerCat = 'all';

    async function loadLinkers() {
      if (linkersData) return;
      const { data, error } = await sb.from('linking_words').select('*').order('sort_order');
      if (error) {
        document.getElementById('linker-content').innerHTML =
          '<div class="no-data">No pude cargar los conectores. ¿Ya corriste el SQL de <b>linking_words</b>?<br><span style="font-size:0.75rem">' + error.message + '</span></div>';
        return;
      }
      linkersData = data || [];
      await loadLinkerProgress();
      const cats = [...new Set(linkersData.map(l => l.category))];
      const pills = ['<div class="cat-chip active" data-lcat="all" onclick="filterLinkers(\'all\', this)">Todos</div>']
        .concat(cats.map(c => `<div class="cat-chip" data-lcat="${c}" onclick="filterLinkers('${c.replace(/'/g,"\\'")}', this)">${c}</div>`));
      document.getElementById('linker-cats').innerHTML = pills.join('');
      renderLinkerConceptChips();
      renderLinkers();
    }

    // Iter A.7 · chips concepto U15 (turquesa) en la sección Conectores
    let activeLinkerConcept = null;
    function renderLinkerConceptChips() {
      const bar = document.getElementById('linker-concept-chips');
      if (!bar) return;
      if (!LC.enabled || LC.contentByConcept.size === 0) { bar.innerHTML = ''; return; }
      const chips = LC_U15_IDS
        .map(cid => ({ cid, count: (LC.contentByConcept.get(cid)?.linkers || []).length }))
        .filter(c => c.count > 0);
      if (chips.length === 0) { bar.innerHTML = ''; return; }
      bar.innerHTML = chips.map(c => {
        const name = LC_SHORT_NAMES[c.cid] || LC.conceptNames.get(c.cid)?.name || ('C' + c.cid);
        const active = activeLinkerConcept === c.cid ? ' active' : '';
        return `<div class="cat-chip cat-chip-concept-u15${active}" onclick="selectLinkerConcept(${c.cid}, this)">
                  ✨ ${escapeHtml(name)} <span class="cat-count">${c.count}</span>
                </div>`;
      }).join('');
    }
    function selectLinkerConcept(cid, el) {
      activeLinkerConcept = cid;
      activeLinkerCat = 'all';
      document.querySelectorAll('#linker-cats .cat-chip').forEach(c => c.classList.remove('active'));
      const allChip = document.querySelector('#linker-cats [data-lcat="all"]');
      if (allChip) allChip.classList.add('active');
      document.querySelectorAll('#linker-concept-chips .cat-chip-concept-u15').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      renderLinkers();
    }

    function filterLinkers(cat, el) {
      activeLinkerCat = cat;
      activeLinkerConcept = null; // filtro legacy limpia el filtro concepto
      document.querySelectorAll('#linker-cats .cat-chip').forEach(c => c.classList.remove('active'));
      if (el) el.classList.add('active');
      document.querySelectorAll('#linker-concept-chips .cat-chip-concept-u15').forEach(c => c.classList.remove('active'));
      renderLinkers();
    }

    function renderLinkers() {
      if (!linkersData) return;
      const q = (document.getElementById('linker-search').value || '').toLowerCase().trim();
      let list;
      if (activeLinkerConcept != null) {
        const ids = new Set((LC.contentByConcept.get(activeLinkerConcept)?.linkers) || []);
        list = linkersData.filter(l => ids.has(l.id));
      } else if (activeLinkerCat === 'all') {
        list = linkersData;
      } else {
        list = linkersData.filter(l => l.category === activeLinkerCat);
      }
      if (q) {
        list = list.filter(l =>
          l.word.toLowerCase().includes(q) ||
          l.translation.toLowerCase().includes(q) ||
          l.example_en.toLowerCase().includes(q) ||
          l.example_es.toLowerCase().includes(q));
      }
      document.getElementById('linker-count').textContent =
        `${list.length} conector${list.length === 1 ? '' : 'es'}`;

      let html = '', lastCat = null;
      list.forEach(l => {
        if (l.category !== lastCat) { html += `<div class="link-cat-title">${l.category}</div>`; lastCat = l.category; }
        const say = (l.example_en || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        html += `
          <div class="link-card">
            <div class="link-head">
              <span class="link-word">${l.word}</span>
              <span class="link-tr">${l.translation}</span>
            </div>
            <div class="link-example">
              <button class="link-audio" onclick="speakEnglish('${say}', this)" title="Escuchar">
                <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              </button>
              <span class="link-en">${l.example_en}</span>
            </div>
            <div class="link-es">${l.example_es}</div>
            ${l.usage ? `<div class="link-usage">💡 ${l.usage}</div>` : ''}
          </div>`;
      });
      document.getElementById('linker-content').innerHTML = html || '<div class="no-data">No se encontraron conectores.</div>';
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  SHADOWING (escuchar → repetir → comparar → repetir)     ║
    // ╚══════════════════════════════════════════════════════════╝
    let shadowDeck = [], shadowIndex = 0, shadowCatsBuilt = false;

    function loadShadow() {
      if (!allPhrases || allPhrases.length === 0) {
        document.getElementById('shadow-phrase').textContent = 'No hay frases disponibles.';
        return;
      }
      if (!shadowCatsBuilt) {
        const cats = [...new Set(allPhrases.map(p => p.category).filter(Boolean))];
        const sel = document.getElementById('shadow-cat');
        sel.innerHTML = '<option value="all">🌐 Todas las frases</option>' +
          cats.map(c => `<option value="${c}">${c}</option>`).join('');
        shadowCatsBuilt = true;
      }
      renderShadowConceptChips();
      if (shadowDeck.length === 0) restartShadow();
    }

    // Iter 10 · barra de chips concepto en Shadowing (mismo patrón que flashcards iter 7)
    let activeShadowConcept = null;
    function renderShadowConceptChips() {
      const bar = document.getElementById('shadow-concept-chips');
      if (!bar) return;
      if (!LC.enabled || LC.contentByConcept.size === 0) { bar.innerHTML = ''; return; }
      const chips = LC_U8_IDS
        .map(cid => ({ cid, count: (LC.contentByConcept.get(cid)?.phrases || []).length }))
        .filter(c => c.count > 0);
      if (chips.length === 0) { bar.innerHTML = ''; return; }
      bar.innerHTML = chips.map(c => {
        const name = LC_SHORT_NAMES[c.cid] || LC.conceptNames.get(c.cid)?.name || ('C' + c.cid);
        const active = activeShadowConcept === c.cid ? ' active' : '';
        return `<div class="cat-chip cat-chip-concept${active}" data-shadow-concept="${c.cid}" onclick="selectShadowConcept(${c.cid}, this)">
                  ✨ ${escapeHtml(name)} <span class="cat-count">${c.count}</span>
                </div>`;
      }).join('');
    }

    function selectShadowConcept(cid, el) {
      activeShadowConcept = cid;
      // Reset del select a "all" para que la vista muestre "estoy filtrando por concepto"
      const sel = document.getElementById('shadow-cat');
      if (sel) sel.value = 'all';
      // Visual: activar solo este chip
      document.querySelectorAll('#shadow-concept-chips .cat-chip-concept').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      const ids = new Set((LC.contentByConcept.get(cid)?.phrases) || []);
      restartShadow(allPhrases.filter(p => ids.has(p.id)));
    }

    function restartShadow(explicitList) {
      let base;
      if (explicitList && explicitList.length) {
        // Lista custom (chip concepto, reviewDue, etc.) — no tocar activeShadowConcept
        base = explicitList;
      } else {
        // Llamada desde el select o programática sin lista → reset del filtro concepto
        activeShadowConcept = null;
        document.querySelectorAll('#shadow-concept-chips .cat-chip-concept.active').forEach(c => c.classList.remove('active'));
        const cat = document.getElementById('shadow-cat').value || 'all';
        base = (cat === 'all') ? allPhrases : allPhrases.filter(p => p.category === cat);
      }
      shadowDeck = shuffle(base);
      shadowIndex = 0;
      renderShadowCard();
    }

    function setShadowStep(step) {
      [1, 2, 3].forEach(n => {
        const el = document.getElementById('sstep-' + n);
        el.classList.toggle('active', n === step);
        el.classList.toggle('done', n < step);
      });
    }

    function renderShadowCard() {
      stopShadowMic();
      const p = shadowDeck[shadowIndex];
      if (!p) return;
      document.getElementById('shadow-phrase').textContent = p.phrase;
      document.getElementById('shadow-trans').textContent  = '';   // se revela al comparar
      document.getElementById('shadow-progress').textContent = `${shadowIndex + 1} / ${shadowDeck.length}`;
      document.getElementById('shadow-mic-hint').textContent = 'Escucha y luego oprime para repetir';
      const fb = document.getElementById('shadow-feedback');
      fb.classList.add('hidden'); fb.innerHTML = '';
      setShadowStep(1);
      // Escuchar primero (auto), como manda el shadowing
      setTimeout(() => shadowPlay(1), 350);
    }

    function shadowPlay(rate) {
      const p = shadowDeck[shadowIndex];
      if (!p) return;
      const btn = document.getElementById('shadow-play');
      // reutiliza speakEnglish pero con rate configurable
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      (async () => {
        if (!cachedEngVoice) cachedEngVoice = await getEnglishVoice();
        const u = new SpeechSynthesisUtterance(p.phrase);
        u.lang = 'en-US'; u.rate = rate; u.pitch = 1;
        if (cachedEngVoice) u.voice = cachedEngVoice;
        u.onstart = () => btn.classList.add('speaking');
        u.onend   = () => { btn.classList.remove('speaking'); if (!document.getElementById('shadow-feedback').classList.contains('hidden')) return; setShadowStep(2); };
        u.onerror = () => btn.classList.remove('speaking');
        window.speechSynthesis.speak(u);
      })();
    }

    function shadowNext() {
      if (shadowIndex < shadowDeck.length - 1) shadowIndex++;
      else shadowIndex = 0;   // vuelve a empezar la baraja
      renderShadowCard();
    }

    function shadowRepeat() { renderShadowCard(); }

    // ── Micrófono de shadowing (PC: Web Speech · móvil: Groq) ─────
    let shRecog = null, shRecorder = null, shChunks = [], shListening = false;

    function toggleShadowMic() { shListening ? stopShadowMic() : startShadowMic(); }

    async function startShadowMic() {
      const p = shadowDeck[shadowIndex];
      if (!p) return;
      const expected = p.phrase;
      const btn  = document.getElementById('shadow-mic');
      const hint = document.getElementById('shadow-mic-hint');
      setShadowStep(2);

      if (useCloudSTT()) {
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { hint.textContent = 'No pude acceder al micrófono. Revisa los permisos.'; return; }
        shChunks = [];
        let opts = {};
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
          if (MediaRecorder.isTypeSupported('audio/webm'))     opts = { mimeType: 'audio/webm' };
          else if (MediaRecorder.isTypeSupported('audio/mp4')) opts = { mimeType: 'audio/mp4' };
        }
        try { shRecorder = new MediaRecorder(stream, opts); }
        catch (e) { shRecorder = new MediaRecorder(stream); }
        shRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) shChunks.push(e.data); };
        shRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const type = (shChunks[0] && shChunks[0].type) || 'audio/webm';
          const blob = new Blob(shChunks, { type }); shChunks = [];
          if (blob.size < 1200) { hint.textContent = 'No te escuché. Intenta de nuevo 🎤'; return; }
          hint.textContent = '⏳ Comparando...';
          try {
            const ext = type.includes('mp4') ? 'mp4' : 'webm';
            const form = new FormData();
            form.append('file', blob, 'audio.' + ext);
            form.append('language', 'en');
            const { data, error } = await sb.functions.invoke('transcribe', { body: form });
            if (error) throw new Error(error.message);
            const said = (data && data.text ? data.text : '').trim();
            if (!said) { hint.textContent = 'No entendí. Intenta de nuevo 🎤'; return; }
            gradeShadow(expected, said);
          } catch (e) { hint.textContent = 'Error: ' + (e.message || e); }
        };
        shRecorder.start();
        shListening = true; btn.classList.add('listening');
        hint.textContent = '🔴 Grabando... oprime otra vez al terminar';
      } else {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { hint.textContent = 'Tu navegador no soporta reconocimiento de voz.'; return; }
        shRecog = new SR();
        shRecog.lang = 'en-US'; shRecog.interimResults = false; shRecog.maxAlternatives = 3;
        shRecog.onstart  = () => { shListening = true; btn.classList.add('listening'); hint.textContent = '🔴 Escuchando... repite la frase'; };
        shRecog.onresult = (e) => {
          let best = e.results[0][0].transcript, bs = scorePronunciation(expected, best);
          for (let i = 1; i < e.results[0].length; i++) {
            const alt = e.results[0][i].transcript, s = scorePronunciation(expected, alt);
            if (s.pct > bs.pct) { bs = s; best = alt; }
          }
          gradeShadow(expected, best);
        };
        shRecog.onerror = (e) => { if (e.error === 'no-speech') hint.textContent = 'No te escuché 🎤'; stopShadowMic(); };
        shRecog.onend   = () => stopShadowMic();
        shRecog.start();
      }
    }

    function stopShadowMic() {
      shListening = false;
      const btn = document.getElementById('shadow-mic');
      if (btn) btn.classList.remove('listening');
      if (shRecog)    { try { shRecog.stop(); } catch (e) {} shRecog = null; }
      if (shRecorder && shRecorder.state !== 'inactive') { try { shRecorder.stop(); } catch (e) {} }
    }

    function gradeShadow(expected, said) {
      stopShadowMic();
      setShadowStep(3);
      const p = shadowDeck[shadowIndex];
      const score = scorePronunciation(expected, said);
      document.getElementById('shadow-trans').textContent = p.translation || '';
      document.getElementById('shadow-mic-hint').textContent =
        score.pct >= 80 ? '🏆 ¡Excelente!' : score.pct >= 50 ? '💪 Bien, repite para pulir' : '🔄 Escucha de nuevo y repite';

      const chips = score.wordResult.map(w =>
        `<span class="word-chip ${w.ok ? 'word-ok' : 'word-miss'}">${w.word}</span>`).join('');
      const badgeCls = score.pct >= 80 ? 'score-great' : score.pct >= 50 ? 'score-good' : 'score-try';
      const fb = document.getElementById('shadow-feedback');
      fb.className = 'quiz-feedback ' + (score.pct >= 70 ? 'good' : 'bad');
      fb.innerHTML = `
        <div class="pronun-header" style="margin-bottom:0.6rem">
          <span class="pronun-title">🎤 Tu repetición</span>
          <span class="score-badge ${badgeCls}">${score.pct}%</span>
        </div>
        <div class="word-row">${chips}</div>
        <div class="pronun-you">Dijiste: <span>${said}</span></div>`;
      fb.classList.remove('hidden');

      // Cuenta para la racha diaria
      if (p && currentUser) {
        markPhraseStudied(p.id);
        scheduleSrs('phrase', p.id, score.pct >= 95 ? 'easy' : score.pct >= 70 ? 'good' : 'again');
        if (LC.enabled) {
          LC.submitFromPhrase(p.id, score.pct >= 70 ? 'pass' : 'fail', 'produce')
            .then(function() { return lcRefreshAndNotify(); })
            .catch(function(e) { console.warn('LC phrase shadow:', e.message); });
        }
      }
    }

    // ╔══════════════════════════════════════════════════════════╗
    // ║  MODO PRÁCTICA de conectores (completa la frase)         ║
    // ╚══════════════════════════════════════════════════════════╝
    const QUIZ_SIZE = 10;
    let quiz = [], quizIndex = 0, quizScore = 0, quizAnswered = false, quizMissed = [];
    let linkerProgress = new Map();   // linker_id -> { attempts, correct, last_result }

    function setLinkerMode(mode) {
      ['study', 'quiz', 'stats'].forEach(m =>
        document.getElementById('mode-' + m).classList.toggle('active', m === mode));
      document.getElementById('linker-study').classList.toggle('hidden', mode !== 'study');
      document.getElementById('linker-quiz').classList.toggle('hidden',  mode !== 'quiz');
      document.getElementById('linker-stats').classList.toggle('hidden', mode !== 'stats');
      if (mode === 'quiz')  startQuiz();
      if (mode === 'stats') renderLinkerStats();
    }

    // ── Guardar / cargar progreso del quiz ────────────────────────
    async function loadLinkerProgress() {
      linkerProgress = new Map();
      if (!currentUser) return;
      const { data, error } = await sb.from('linker_progress')
        .select('linker_id,attempts,correct,last_result');
      if (error) { console.warn('linker_progress:', error.message); return; }
      (data || []).forEach(r => linkerProgress.set(r.linker_id, {
        attempts: r.attempts, correct: r.correct, last_result: r.last_result
      }));
    }

    async function saveLinkerAnswer(linkerId, wasCorrect) {
      if (!currentUser) return;
      const prev = linkerProgress.get(linkerId) || { attempts: 0, correct: 0 };
      const row = {
        user_id:   currentUser.id,
        linker_id: linkerId,
        attempts:  prev.attempts + 1,
        correct:   prev.correct + (wasCorrect ? 1 : 0),
        last_result: wasCorrect,
        last_practiced: new Date().toISOString()
      };
      linkerProgress.set(linkerId, { attempts: row.attempts, correct: row.correct, last_result: wasCorrect });
      const { error } = await sb.from('linker_progress')
        .upsert(row, { onConflict: 'user_id,linker_id' });
      if (error) console.warn('saveLinkerAnswer:', error.message);

      // ── Learning Core · hook activo (Batch A · iter A.5) ─────────
      // Ruta evidence-only vía LC.submitFromLinker: resuelve linker → concepto
      // U15 (linker-XXX) y registra outcome. Fire-and-forget.
      if (LC.enabled) {
        LC.submitFromLinker(linkerId, wasCorrect)
          .then(() => lcRefreshAndNotify())
          .catch(function(e) { console.warn('LC dual-write (linkers):', e.message); });
      }
    }

    // Calcula estadísticas: qué domina y qué debe reforzar
    function linkerStats() {
      const rows = [];
      (linkersData || []).forEach(l => {
        const p = linkerProgress.get(l.id);
        if (p && p.attempts > 0) rows.push({ linker: l, ...p, acc: p.correct / p.attempts });
      });
      const totalAttempts = rows.reduce((a, b) => a + b.attempts, 0);
      const totalCorrect  = rows.reduce((a, b) => a + b.correct, 0);
      const weak   = rows.filter(r => r.acc < 0.7).sort((a, b) => a.acc - b.acc);
      const strong = rows.filter(r => r.acc >= 0.8 && r.attempts >= 2).sort((a, b) => b.acc - a.acc);
      return { rows, practiced: rows.length, totalAttempts, totalCorrect, weak, strong };
    }

    // Ubica el conector dentro de su ejemplo para poder dejar el hueco
    function linkerBlank(l) {
      const term = (l.word.split('/')[0] || '').trim().replace(/\?+$/, '').trim();
      if (!term) return null;
      const idx = l.example_en.toLowerCase().indexOf(term.toLowerCase());
      if (idx === -1) return null;
      return { before: l.example_en.slice(0, idx), after: l.example_en.slice(idx + term.length) };
    }

    function startQuiz(weakOnly, explicitPool) {
      if (!linkersData) return;
      let base;
      if (explicitPool) {
        base = explicitPool;
      } else if (weakOnly === true) {
        const weakIds = new Set(linkerStats().weak.map(w => w.linker.id));
        base = linkersData.filter(l => weakIds.has(l.id));
      } else if (activeLinkerConcept != null) {
        // Iter A.7: filtro concepto U15 activo
        const ids = new Set((LC.contentByConcept.get(activeLinkerConcept)?.linkers) || []);
        base = linkersData.filter(l => ids.has(l.id));
      } else {
        base = activeLinkerCat === 'all' ? linkersData : linkersData.filter(l => l.category === activeLinkerCat);
      }
      const pool = base.filter(l => linkerBlank(l));
      const msg = document.getElementById('quiz-msg');
      if (pool.length < (explicitPool ? 1 : 4)) {
        msg.innerHTML = weakOnly === true
          ? '<div class="no-data">Aún no tienes suficientes conectores por reforzar. ¡Practica un poco más primero! 💪</div>'
          : '<div class="no-data">Pocos conectores en esta categoría para practicar.<br>Elige <b>Todos</b> u otra categoría en el modo Estudiar.</div>';
        document.getElementById('quiz-play').classList.add('hidden');
        document.getElementById('quiz-result').classList.add('hidden');
        return;
      }
      msg.innerHTML = '';
      quizMissed = [];
      const chosen = shuffle(pool).slice(0, Math.min(QUIZ_SIZE, pool.length));
      quiz = chosen.map(l => {
        const distract = shuffle(linkersData.filter(x => x.word !== l.word)).slice(0, 3);
        const options  = shuffle([l, ...distract]);
        return { linker: l, blank: linkerBlank(l), options, answer: options.findIndex(o => o.word === l.word) };
      });
      quizIndex = 0; quizScore = 0;
      document.getElementById('quiz-result').classList.add('hidden');
      document.getElementById('quiz-play').classList.remove('hidden');
      renderQuizQuestion();
    }

    function renderQuizQuestion() {
      quizAnswered = false;
      const q = quiz[quizIndex];
      document.getElementById('quiz-progress').textContent = `Pregunta ${quizIndex + 1} de ${quiz.length}`;
      document.getElementById('quiz-score').textContent    = quizScore;
      document.getElementById('quiz-bar-fill').style.width = (quizIndex / quiz.length * 100) + '%';
      document.getElementById('quiz-sentence').innerHTML =
        `${q.blank.before}<span class="quiz-blank">_____</span>${q.blank.after}`;
      document.getElementById('quiz-options').innerHTML = q.options.map((o, i) =>
        `<button class="quiz-opt" id="qopt-${i}" onclick="answerQuiz(${i})">${o.word}</button>`).join('');
      const fb = document.getElementById('quiz-feedback');
      fb.classList.add('hidden'); fb.innerHTML = '';
      document.getElementById('quiz-next').classList.add('hidden');
    }

    function answerQuiz(i) {
      if (quizAnswered) return;
      quizAnswered = true;
      const q = quiz[quizIndex];
      const correct = i === q.answer;
      if (correct) quizScore++;
      else quizMissed.push(q.linker);
      saveLinkerAnswer(q.linker.id, correct);   // guarda en tu perfil
      scheduleSrs('linker', q.linker.id, correct ? 'good' : 'again');
      q.options.forEach((o, idx) => {
        const btn = document.getElementById('qopt-' + idx);
        if (idx === q.answer)    btn.classList.add('ok');
        else if (idx === i)      btn.classList.add('bad');
        btn.disabled = true;
      });
      const l  = q.linker;
      const fb = document.getElementById('quiz-feedback');
      fb.className = 'quiz-feedback ' + (correct ? 'good' : 'bad');
      fb.innerHTML = `
        <div class="qfb-title">${correct ? '✅ ¡Correcto!' : '❌ La respuesta era: ' + l.word}</div>
        <div class="qfb-en">${l.example_en}</div>
        <div class="qfb-es">${l.example_es}</div>
        ${l.usage ? `<div class="qfb-usage">💡 ${l.usage}</div>` : ''}`;
      fb.classList.remove('hidden');
      document.getElementById('quiz-score').textContent = quizScore;
      const next = document.getElementById('quiz-next');
      next.textContent = (quizIndex === quiz.length - 1) ? 'Ver resultado 🏁' : 'Siguiente →';
      next.classList.remove('hidden');
      speakEnglish(l.example_en);   // escuchar la frase correcta
    }

    function nextQuizQuestion() {
      if (quizIndex < quiz.length - 1) { quizIndex++; renderQuizQuestion(); }
      else showQuizResult();
    }

    function showQuizResult() {
      document.getElementById('quiz-play').classList.add('hidden');
      const pct = Math.round(quizScore / quiz.length * 100);
      const cls = pct >= 80 ? 'score-circle-great' : pct >= 50 ? 'score-circle-good' : 'score-circle-try';
      const msg = pct === 100 ? '🏆 ¡Perfecto! Dominas estos conectores.'
                : pct >= 80   ? '🎉 ¡Muy bien! Casi todos correctos.'
                : pct >= 50   ? '💪 Buen intento. Repasa los que fallaste.'
                :               '📖 Vuelve al modo Estudiar y luego inténtalo de nuevo.';
      const missHtml = quizMissed.length ? `
        <div class="miss-box">
          <div class="miss-title">📌 Para reforzar de esta ronda</div>
          ${quizMissed.map(l => `<div class="miss-item"><b>${l.word}</b> — ${l.translation}</div>`).join('')}
        </div>` : '';
      const saveNote = currentUser ? '' :
        '<div class="quiz-res-msg" style="color:#fbbf24">💡 Inicia sesión para guardar tu progreso y saber qué reforzar.</div>';

      document.getElementById('quiz-result').innerHTML = `
        <div class="score-circle ${cls}"><span>${pct}%</span><span class="score-circle-label">ACIERTOS</span></div>
        <div class="quiz-res-txt">${quizScore} de ${quiz.length} correctas</div>
        <div class="quiz-res-msg">${msg}</div>
        ${missHtml}
        ${saveNote}
        <button class="btn btn-primary" style="width:100%; justify-content:center; margin-bottom:0.6rem;" onclick="startQuiz()">🔄 Practicar de nuevo</button>
        ${currentUser ? '<button class="btn btn-secondary" style="width:100%; justify-content:center; margin-bottom:0.6rem;" onclick="setLinkerMode(\'stats\')">📊 Ver mi progreso</button>' : ''}
        <button class="btn btn-secondary" style="width:100%; justify-content:center;" onclick="setLinkerMode('study')">📖 Volver a estudiar</button>`;
      document.getElementById('quiz-result').classList.remove('hidden');
    }

    // ── Panel: Mi progreso de conectores ──────────────────────────
    function practiceWeak() {
      setLinkerMode('quiz');
      startQuiz(true);
    }

    function renderLinkerStats() {
      renderProgressPanel('linker-stats', linkerStats(), {
        dataReady: !!linkersData,
        emptyMsg: 'Todavía no has practicado conectores.<br>Ve a <b>🎯 Practicar</b> y haz tu primer quiz.',
        unit: 'conectores',
        wordOf: r => r.linker.word,
        subOf:  r => r.linker.translation,
        onPractice: 'practiceWeak()',
        onQuiz: "setLinkerMode('quiz')",
      });
    }

    function toggleAuthMode() {
      authMode = (authMode === 'login') ? 'signup' : 'login';
      const isLogin = authMode === 'login';
      document.getElementById('auth-sub').textContent       = isLogin ? 'Inicia sesión para guardar tu progreso' : 'Crea tu cuenta para empezar';
      document.getElementById('btn-auth-submit').textContent = isLogin ? 'Iniciar sesión' : 'Crear cuenta';
      document.getElementById('auth-toggle').innerHTML       = isLogin
        ? '¿No tienes cuenta? <a onclick="toggleAuthMode()">Regístrate</a>'
        : '¿Ya tienes cuenta? <a onclick="toggleAuthMode()">Inicia sesión</a>';
      setAuthMsg('', '');
    }

    function setAuthMsg(text, type) {
      const el = document.getElementById('auth-msg');
      el.textContent = text;
      el.className = 'auth-msg ' + (type || '');
    }

    async function submitAuth() {
      const email = document.getElementById('auth-email').value.trim();
      const pass  = document.getElementById('auth-password').value;
      if (!email || !pass) { setAuthMsg('Escribe tu correo y contraseña.', 'err'); return; }
      if (pass.length < 6) { setAuthMsg('La contraseña debe tener al menos 6 caracteres.', 'err'); return; }

      const btn = document.getElementById('btn-auth-submit');
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Procesando...';

      try {
        if (authMode === 'signup') {
          const { data, error } = await sb.auth.signUp({ email, password: pass });
          if (error) throw error;
          if (data.session) {
            currentUser = data.user;
            enterApp();
          } else {
            // Requiere confirmación por correo
            setAuthMsg('✅ Cuenta creada. Revisa tu correo para confirmar y luego inicia sesión.', 'ok');
            authMode = 'login';
          }
        } else {
          const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
          if (error) throw error;
          currentUser = data.user;
          enterApp();
        }
      } catch(e) {
        let msg = e.message || 'Error de autenticación';
        if (/invalid login/i.test(msg))       msg = 'Correo o contraseña incorrectos.';
        if (/already registered/i.test(msg))   msg = 'Ese correo ya está registrado. Inicia sesión.';
        if (/not confirmed/i.test(msg))        msg = 'Debes confirmar tu correo antes de entrar.';
        setAuthMsg(msg, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    async function loginGoogle() {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href.split('#')[0] }
      });
      if (error) setAuthMsg('Google: ' + error.message, 'err');
    }

    function skipAuth() {
      currentUser = null;
      enterApp();
    }

    async function logout() {
      await sb.auth.signOut();
      currentUser = null;
      progressMap = new Map();
      location.reload();
    }

    function showCard(index) {
      if (index >= phrases.length) {
        document.getElementById('main-content').classList.add('hidden');
        document.getElementById('completed').classList.remove('hidden');
        return;
      }
      current = index;
      seen.add(index);
      const p = phrases[index];
      document.getElementById('phrase-text').textContent      = p.phrase;
      document.getElementById('translation-text').textContent = p.translation;
      document.getElementById('description-text').textContent = p.description;
      document.getElementById('flashcard').classList.remove('flipped');
      hidePronunPanel();
      reflectMastered(p.id);
      updateCardProgress();
      updateStats();
    }

    // Barra = meta diaria (motivante); subtexto = acumulado real
    function updateCardProgress() {
      const done = studiedTodayIds.size;
      const goal = DAILY_GOAL;
      const pct  = Math.min(100, Math.round(done / goal * 100));
      const met  = done >= goal;
      const fill = document.getElementById('progress-fill');
      document.getElementById('progress-text').textContent = met ? '✓ ¡Meta de hoy cumplida!' : '🎯 Meta de hoy';
      document.getElementById('progress-pct').textContent  = done + ' / ' + goal;
      fill.style.width = pct + '%';
      fill.classList.toggle('met', met);

      // Acumulado del banco completo
      let mastered = 0;
      allPhrases.forEach(p => { if (progressMap.get(p.id)?.status === 'mastered') mastered++; });
      const total = allPhrases.length || 1;
      const mpct = Math.round(mastered / total * 100);
      const sub = document.getElementById('progress-sub');
      if (sub) {
        sub.innerHTML = `<span class="prog-sub-strong">${mastered}</span> de ${total} dominadas`
          + ` <span class="prog-sub-mini">(${mpct}% del banco)</span>`
          + `  ·  tarjeta ${current + 1}`;
      }
    }

    // Refleja en la UI si la frase actual está dominada
    function reflectMastered(phraseId) {
      const isMastered = progressMap.get(phraseId)?.status === 'mastered';
      const ribbon = document.getElementById('master-ribbon');
      if (ribbon) ribbon.classList.toggle('show', isMastered && !!currentUser);
    }

    // Calificar la tarjeta: "No lo sé" / "Lo tengo" (alimenta el SRS) y avanzar
    function rateCard(quality) {
      const p = phrases[current];
      if (p && currentUser) {
        const status = quality === 'good' ? 'mastered' : 'practicing';
        saveProgress(p.id, { status }).then(() => { reflectMastered(p.id); updateStats(); });
        scheduleSrs('phrase', p.id, quality);
        markPhraseStudied(p.id);
        if (LC.enabled) {
          LC.submitFromPhrase(p.id, quality !== 'again' ? 'pass' : 'fail', 'recognize')
            .then(function() { return lcRefreshAndNotify(); })
            .catch(function(e) { console.warn('LC phrase rate:', e.message); });
        }
      }
      nextCard();
    }

    // Alterna dominada (atajo 'm')
    async function toggleMastered() {
      if (!currentUser) return;
      const p = phrases[current];
      const isMastered = progressMap.get(p.id)?.status === 'mastered';
      const newStatus = isMastered ? 'practicing' : 'mastered';
      await saveProgress(p.id, { status: newStatus });
      reflectMastered(p.id);
      updateStats();
    }

    function flipCard()  {
      const card = document.getElementById('flashcard');
      card.classList.toggle('flipped');
      // Al revelar la traducción cuenta como "estudiar" esa frase
      if (card.classList.contains('flipped') && phrases[current]) {
        markPhraseStudied(phrases[current].id);
        updateCardProgress();
      }
    }
    function nextCard()  { if (current < phrases.length - 1) showCard(current + 1); else { document.getElementById('main-content').classList.add('hidden'); document.getElementById('completed').classList.remove('hidden'); } }
    function prevCard()  { if (current > 0) showCard(current - 1); }
    function updateStats() {
      document.getElementById('stat-total').textContent     = phrases.length;
      document.getElementById('stat-seen').textContent      = seen.size;
      document.getElementById('stat-remaining').textContent = phrases.length - seen.size;
      // Dominadas dentro del set actual
      let mastered = 0;
      phrases.forEach(p => { if (progressMap.get(p.id)?.status === 'mastered') mastered++; });
      document.getElementById('stat-mastered').textContent = mastered;
    }
    function restartDeck() {
      seen.clear();
      document.getElementById('completed').classList.add('hidden');
      document.getElementById('main-content').classList.remove('hidden');
      loadPhrases();
    }

    // ── Text-to-Speech ────────────────────────────────────────────
    let cachedEngVoice = null;

    function getEnglishVoice() {
      return new Promise(resolve => {
        const tryGet = () => {
          const voices = window.speechSynthesis.getVoices();
          const voice  = voices.find(v => v.lang === 'en-US' && v.localService)
                      || voices.find(v => v.lang === 'en-US')
                      || voices.find(v => v.lang === 'en-GB')
                      || voices.find(v => v.lang.startsWith('en'));
          resolve(voice || null);
        };
        if (window.speechSynthesis.getVoices().length > 0) tryGet();
        else window.speechSynthesis.onvoiceschanged = tryGet;
      });
    }

    async function speakPhrase() {
      if (!('speechSynthesis' in window)) return;
      const text = document.getElementById('phrase-text').textContent;
      if (!text) return;
      window.speechSynthesis.cancel();
      const btn = document.getElementById('btn-audio');
      if (!cachedEngVoice) cachedEngVoice = await getEnglishVoice();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang  = 'en-US'; utter.rate = 0.88; utter.pitch = 1;
      if (cachedEngVoice) utter.voice = cachedEngVoice;
      utter.onstart = () => btn.classList.add('speaking');
      utter.onend   = () => btn.classList.remove('speaking');
      utter.onerror = () => btn.classList.remove('speaking');
      window.speechSynthesis.speak(utter);
    }

    // ── Pronunciation Check ───────────────────────────────────────
    let recognition = null;
    let isListening = false;

    function buildRecognition() {
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRec) return null;
      const r = new SpeechRec();
      r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 3;
      return r;
    }

    // ¿Usar transcripción en la nube? (móvil / iOS / sin Web Speech API)
    function useCloudSTT() {
      const ua = navigator.userAgent || '';
      const isIOS = /iPad|iPhone|iPod/.test(ua) ||
                    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isAndroid = /Android/.test(ua);
      const hasWebSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
      return isIOS || isAndroid || !hasWebSpeech;
    }

    function toggleMic() {
      if (useCloudSTT()) {
        isListening ? stopCloudRecording() : startCloudRecording();
      } else {
        isListening ? stopListening() : startListening();
      }
    }

    // Lógica compartida: registra el resultado, guarda progreso y lo muestra
    function finishPronun(expected, said, score) {
      practiceLog.push({
        phrase: expected,
        translation: phrases[current]?.translation || '',
        score: score.pct,
        said:  said,
        timestamp: Date.now()
      });
      const p = phrases[current];
      if (p && currentUser) {
        const autoStatus = score.pct >= 80 ? 'mastered' : undefined;
        saveProgress(p.id, { status: autoStatus, score: score.pct })
          .then(() => { reflectMastered(p.id); updateStats(); });
        markPhraseStudied(p.id);
      }
      showPronunResult(expected, said, score);
    }

    // ── Modo nube: grabar audio y enviarlo a la Edge Function ─────
    let mediaRecorder = null, recordedChunks = [];

    async function startCloudRecording() {
      hidePronunPanel();
      const btn = document.getElementById('btn-mic');
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch(e) {
        showPronunError('No pude acceder al micrófono. Revisa los permisos del navegador.');
        return;
      }
      startWaveform(stream);
      recordedChunks = [];
      let options = {};
      if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm'))     options = { mimeType: 'audio/webm' };
        else if (MediaRecorder.isTypeSupported('audio/mp4')) options = { mimeType: 'audio/mp4' };
      }
      try { mediaRecorder = new MediaRecorder(stream, options); }
      catch(e) { mediaRecorder = new MediaRecorder(stream); }
      mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = handleCloudStop;
      mediaRecorder.start();
      isListening = true;
      btn.classList.add('listening');
      btn.title = 'Grabando... (click para terminar)';
    }

    function stopCloudRecording() {
      isListening = false;
      document.getElementById('btn-mic').classList.remove('listening');
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();  // dispara handleCloudStop
      }
    }

    async function handleCloudStop() {
      stopWaveform();
      const type = (recordedChunks[0] && recordedChunks[0].type) || 'audio/webm';
      const blob = new Blob(recordedChunks, { type });
      recordedChunks = [];
      if (blob.size < 1200) { showPronunError('No te escuché. Intenta de nuevo 🎤'); return; }

      const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
      showPronunLoading();
      try {
        const form = new FormData();
        form.append('file', blob, 'audio.' + ext);
        form.append('language', 'en');
        const { data, error } = await sb.functions.invoke('transcribe', { body: form });
        if (error) throw new Error(error.message || 'Error en la transcripción');
        const said = (data && data.text ? data.text : '').trim();
        if (!said) { showPronunError('No entendí lo que dijiste. Intenta de nuevo 🎤'); return; }
        const expected = document.getElementById('phrase-text').textContent;
        finishPronun(expected, said, scorePronunciation(expected, said));
      } catch(e) {
        showPronunError('Error transcribiendo: ' + (e.message || e));
      }
    }

    // ── Waveform ──────────────────────────────────────────────────
    let audioCtx = null, analyser = null, micStream = null, animFrame = null;
    const BAR_COUNT = 40;

    function buildWaveBars() {
      const c = document.getElementById('waveform-container');
      c.innerHTML = '';
      for (let i = 0; i < BAR_COUNT; i++) {
        const b = document.createElement('div');
        b.className = 'wave-bar'; c.appendChild(b);
      }
    }

    async function startWaveform(existingStream) {
      buildWaveBars();
      try {
        micStream = existingStream || await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
        analyser  = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        audioCtx.createMediaStreamSource(micStream).connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const bars      = document.querySelectorAll('.wave-bar');
        document.getElementById('waveform-container').classList.add('active');
        function draw() {
          animFrame = requestAnimationFrame(draw);
          analyser.getByteFrequencyData(dataArray);
          bars.forEach((bar, i) => {
            const idx   = Math.floor((i < BAR_COUNT/2 ? i : BAR_COUNT-1-i) / (BAR_COUNT/2) * dataArray.length * 0.6);
            const value = dataArray[idx] || 0;
            bar.style.height     = Math.max(4, (value/255)*56) + 'px';
            bar.style.background = `linear-gradient(180deg, rgb(${239+Math.round(16*(value/255))},${Math.round(68*(1-value/255))},68), #ef4444)`;
          });
        }
        draw();
      } catch(e) {}
    }

    function stopWaveform() {
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
      if (audioCtx)  { audioCtx.close(); audioCtx = null; }
      if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
      analyser = null;
      document.getElementById('waveform-container').classList.remove('active');
      document.querySelectorAll('.wave-bar').forEach(b => b.style.height = '4px');
    }

    function startListening() {
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRec) { alert('Usa Chrome o Edge para reconocimiento de voz.'); return; }
      hidePronunPanel();
      recognition = buildRecognition();
      const btn   = document.getElementById('btn-mic');

      recognition.onstart = () => {
        isListening = true;
        btn.classList.add('listening');
        startWaveform();
      };

      recognition.onresult = (e) => {
        const expected = document.getElementById('phrase-text').textContent;
        let bestResult = e.results[0][0].transcript;
        let bestScore  = scorePronunciation(expected, bestResult);
        for (let i = 1; i < e.results[0].length; i++) {
          const alt   = e.results[0][i].transcript;
          const score = scorePronunciation(expected, alt);
          if (score.pct > bestScore.pct) { bestScore = score; bestResult = alt; }
        }
        finishPronun(expected, bestResult, bestScore);
      };

      recognition.onerror = (e) => {
        stopListening();
        if (e.error === 'no-speech')    showPronunError('No te escuché. Intenta de nuevo 🎤');
        else if (e.error === 'aborted') {}
        else showPronunError('Error: ' + e.error);
      };

      recognition.onend = () => stopListening();
      recognition.start();
    }

    function stopListening() {
      isListening = false;
      document.getElementById('btn-mic').classList.remove('listening');
      if (recognition) { try { recognition.stop(); } catch(e){} recognition = null; }
      stopWaveform();
    }

    // ── Scoring ───────────────────────────────────────────────────
    function normalize(str) {
      return str.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().split(/\s+/);
    }

    function scorePronunciation(expected, said) {
      const expWords  = normalize(expected);
      const saidWords = normalize(said);
      let correct = 0;
      const matched = new Array(saidWords.length).fill(false);
      const wordResult = expWords.map(w => {
        const idx = saidWords.findIndex((s,i) => s === w && !matched[i]);
        if (idx !== -1) { matched[idx] = true; correct++; return { word: w, ok: true }; }
        return { word: w, ok: false };
      });
      const extraWords = saidWords.filter((_,i) => !matched[i]);
      return { pct: Math.round((correct / expWords.length) * 100), wordResult, extraWords, said };
    }

    // ── Render pronunciation result ───────────────────────────────
    function showPronunResult(expected, said, score) {
      const panel = document.getElementById('pronun-panel');
      const badge = document.getElementById('score-badge');
      const row   = document.getElementById('word-row');
      badge.textContent = score.pct + '%';
      badge.className   = 'score-badge ' + (score.pct >= 80 ? 'score-great' : score.pct >= 50 ? 'score-good' : 'score-try');
      row.innerHTML = '';
      score.wordResult.forEach(w => {
        const chip = document.createElement('span');
        chip.className   = 'word-chip ' + (w.ok ? 'word-ok' : 'word-miss');
        chip.textContent = w.word;
        row.appendChild(chip);
      });
      score.extraWords.forEach(w => {
        const chip = document.createElement('span');
        chip.className = 'word-chip word-extra'; chip.textContent = w;
        row.appendChild(chip);
      });
      document.getElementById('you-said').textContent = said || '—';
      const tip = document.getElementById('pronun-tip');
      if      (score.pct === 100) tip.textContent = '🏆 ¡Perfecto! Tu pronunciación fue exacta.';
      else if (score.pct >= 80)   tip.textContent = '✅ ¡Muy bien! Casi perfecto.';
      else if (score.pct >= 50)   tip.textContent = '💪 Buen intento. Escucha y repite.';
      else                        tip.textContent = '🔄 Practica más. Escucha primero con 🔊 y luego repite.';
      panel.classList.remove('hidden');
    }

    function showPronunError(msg) {
      document.getElementById('score-badge').textContent = '—';
      document.getElementById('score-badge').className   = 'score-badge score-try';
      document.getElementById('word-row').innerHTML      = '';
      document.getElementById('you-said').textContent    = '';
      document.getElementById('pronun-tip').textContent  = msg;
      document.getElementById('pronun-panel').classList.remove('hidden');
    }

    // Estado "transcribiendo..." mientras responde la nube
    function showPronunLoading() {
      document.getElementById('score-badge').textContent = '···';
      document.getElementById('score-badge').className   = 'score-badge score-good';
      document.getElementById('word-row').innerHTML      = '';
      document.getElementById('you-said').textContent    = '';
      document.getElementById('pronun-tip').textContent  = '⏳ Transcribiendo tu voz...';
      document.getElementById('pronun-panel').classList.remove('hidden');
    }

    function hidePronunPanel() {
      document.getElementById('pronun-panel').classList.add('hidden');
      // Cancelar grabación en curso sin disparar transcripción
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.onstop = null; mediaRecorder.stop(); } catch(e){}
        isListening = false;
        document.getElementById('btn-mic').classList.remove('listening');
        stopWaveform();
      }
      stopListening();
    }

    // ── Keyboard shortcuts ────────────────────────────────────────
    document.addEventListener('keydown', e => {
      // No interferir mientras se escribe en un input (login)
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        if (e.key === 'Enter') submitAuth();
        return;
      }
      // No actuar si la pantalla de login está visible
      if (document.getElementById('auth-overlay').style.display !== 'none') return;

      const reportOpen   = !document.getElementById('report-modal').classList.contains('hidden');
      const progressOpen = !document.getElementById('progress-modal').classList.contains('hidden');
      const addpOpen     = !document.getElementById('addphrase-modal').classList.contains('hidden');

      if (addpOpen)     { if (e.key === 'Escape') closeAddPhrase();         return; }
      if (reportOpen)   { if (e.key === 'Escape') closeReport();            return; }
      if (progressOpen) { if (e.key === 'Escape') closeProgressDashboard(); return; }

      if (e.key === 'ArrowRight' || e.key === 'Enter') nextCard();
      if (e.key === 'ArrowLeft')  prevCard();
      if (e.key === ' ')          { e.preventDefault(); flipCard(); }
      if (e.key === 'r' || e.key === 'R') toggleMic();
      if (e.key === 't' || e.key === 'T') timerRunning ? stopTimer() : startTimer();
      if (e.key === 'm' || e.key === 'M') toggleMastered();
    });

    init();
  
