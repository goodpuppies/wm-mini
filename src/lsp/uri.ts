import { fileURLToPath, pathToFileURL } from "node:url";

export function pathToFileUri(path: string): string {
  return pathToFileURL(path).href;
}

export function fileUriToPath(uri: string): string {
  return fileURLToPath(uri);
}
