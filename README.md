# 🃏 English Flashcards

Aplicación web para practicar frases en inglés con flashcards interactivas.

**App en vivo:** https://TU-USUARIO.github.io/english-flashcards/

## ✨ Características

- 🃏 Flashcards con animación 3D (flip)
- 🏷️ Filtro por 7 categorías (Negocios, Turismo, Salud, etc.)
- 🔊 Audio de la frase en inglés (Web Speech API)
- 🎤 Validación de pronunciación con score palabra por palabra
- 📊 Visualizador de ondas en tiempo real con el micrófono
- ⏱️ Timer de práctica
- 📈 Reporte de sesión con frases falladas y sugerencias

## 🛠️ Tecnología

- **Frontend:** HTML + CSS + JavaScript puro (sin frameworks)
- **Base de datos:** [Supabase](https://supabase.com) (PostgreSQL + API REST)
- **Audio / Reconocimiento de voz:** Web Speech API del navegador
- **Hosting:** GitHub Pages

> El audio y el reconocimiento de voz corren en el navegador del usuario,
> por eso funcionan mejor en **Google Chrome** o **Microsoft Edge**.

## 🚀 Cómo desplegar

1. Sube este repo a GitHub
2. Settings → Pages → Source: `main` / `(root)` → Save
3. Listo: tu app queda en `https://TU-USUARIO.github.io/NOMBRE-REPO/`

## 📝 Configuración

Las credenciales de Supabase están en `index.html` (constantes `SUPABASE_URL` y
`SUPABASE_KEY`). La key es la **publishable key** (pública y segura): solo permite
leer las frases gracias a la política RLS de la base de datos.
