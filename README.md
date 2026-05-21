# threads

a mind map + agent orchestrator on top of a directory of markdown files.
each thread is a note (a durable markdown doc) plus one or more convos --
a convo is an agent running in a terminal. a thread always has a `default`
convo and can have more, so several agents can work a thread in parallel.
threads can have subthreads, forming a tree. the filesystem is the API --
editing `.md` files in the threads directory drives the system.

## run

```sh
npm install
npm run dev
```

`npm run dev` starts the API server and the web app together. open the
printed URL (default `http://127.0.0.1:5224`).

To run the two halves separately:

```sh
npm run server   # API server (auto-spawns the PTY supervisor on demand)
npm run vite     # web app
```

## thread files

Threads live as `.md` files under `threads/` (the directory beside this
README). Each file has YAML frontmatter (`id`, `title`, `parent_id`,
`convos`, ...) and a markdown body. The server watches the directory and
broadcasts changes to the UI. `threads-protocol.md` is the system prompt
appended to every agent spawned in a thread terminal.

## config (env vars)

| var                  | default                        | purpose                              |
| -------------------- | ------------------------------ | ------------------------------------ |
| `PORT`               | `5224`                         | web app port                         |
| `THREADS_API_PORT`   | `5314`                         | API server port                      |
| `THREADS_PTY_SOCKET` | a path under the system tmpdir | PTY supervisor unix socket           |
| `THREADS_PTY_CWD`    | `process.cwd()`                | working dir thread terminals open in |
| `HOST`               | `127.0.0.1`                    | web app bind host                    |

Set a distinct `THREADS_PTY_SOCKET`, `PORT`, and `THREADS_API_PORT` to run
more than one instance on the same machine.

## requirements

Node 20+. Thread terminals launch whatever agent CLI you point them at
(e.g. `claude`, `codex`); install those separately if you want to use them.
