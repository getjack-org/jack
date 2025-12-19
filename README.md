<p align="center">
  <h1 align="center">jack</h1>
  <p align="center"><strong>Ship before you forget why you started.</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@getjack/jack"><img src="https://img.shields.io/npm/v/@getjack/jack" alt="npm"></a>
  <a href="https://github.com/getjack-org/jack/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license"></a>
</p>

---

You're vibecoding. Ideas are flowing. You want to ship.

But first: config files, deployment setup, secret management, debugging infrastructure errors...

**30 minutes later, the spark is gone.**

jack removes the friction between your idea and a live URL.

```bash
bunx @getjack/jack new my-app   # → deployed. live. done.
```

That's it. Write code. Ship again with `jack ship`. Stay in flow.

---

## ✨ Why jack

**⚡ Instant deployment** — `jack new` creates AND deploys. You have a live URL before your first commit.

**🤖 Works with your agent** — Claude Code, Cursor, Codex, whatever. Every project includes AI context files so your agent understands the stack from prompt one.

**🔑 Roaming secrets** — Configure once, use across all projects. No more per-project secret ceremony.

**📋 Project tracking** — 100 experiments scattered everywhere? `jack list` finds them all.

**🚪 No lock-in** — Standard config files, standard TypeScript. Your projects work without jack installed.

---

## 🚀 Quick Start

```bash
# One command to create and deploy
bunx @getjack/jack new my-app

# Or install globally
bun add -g @getjack/jack
jack new my-app
```

You'll need [Bun](https://bun.sh) and a Cloudflare account (free tier works).

---

## 📦 Commands

| Command | What it does |
|---------|--------------|
| `jack new <name>` | Create and deploy a new project |
| `jack ship` | Deploy current project |
| `jack list` | Show all your projects |
| `jack open` | Open project in browser |
| `jack status` | Check deployment status |

---

## 🎯 Who This Is For

Vibecoders. People who ship 10 experiments a week. Solo devs with more ideas than weekends.

You don't want deployment pipelines and approval flows. You want to build something and share it. jack keeps you there.

---

## 🧠 Philosophy

In Gibson's *Neuromancer*, "jacking in" means plugging directly into cyberspace. The body becomes irrelevant—you're pure thought in the matrix.

jack handles the infrastructure so you stay in creative flow. The boring parts disappear. You just build.

Read the full philosophy in [SPIRIT.md](docs/SPIRIT.md).

---

## 📄 License

Apache-2.0

<p align="center">
  <i>Every deployment friction point is a creative thought lost.</i>
</p>
