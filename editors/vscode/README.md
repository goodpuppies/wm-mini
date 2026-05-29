# wm-mini VS Code Extension

Small VS Code client for wm-mini. It intentionally launches the language server from Deno source so
frontend and LSP changes are picked up by running `wm-mini: Restart Language Server`.

The server is launched with `--allow-read --allow-env`. Environment access is needed because the
language server uses TypeScript's compiler API for JS FFI type reflection.

## Development

```sh
npm install
npm run compile
```

Open this folder as a VS Code extension development host, or package it later as a VSIX. The
included `Run wm-mini Extension` launch config opens the repository root as the test workspace.

By default the extension looks for `src/lsp/server.ts` in the open workspace. If you install the
extension once and edit `.wm` files from another workspace, set:

```json
{
  "wmMini.serverPath": "/absolute/path/to/wm-mini/src/lsp/server.ts"
}
```

Then updates to the wm-mini checkout usually only need `wm-mini: Restart Language Server`.
