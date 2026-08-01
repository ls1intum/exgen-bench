import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveContained(root: string, candidate: string, subject: string): string {
  if (isAbsolute(candidate)) {
    throw new Error(`${subject} paths must be relative: ${candidate}`);
  }
  const absolute = resolve(root, candidate);
  const relativePath = relative(root, absolute);
  const segments = relativePath.split(sep);
  if (isAbsolute(relativePath) || segments.includes("..")) {
    throw new Error(`${subject} escapes its output directory: ${candidate}`);
  }
  return absolute;
}

export async function rejectSymlinkComponents(
  root: string,
  candidate: string,
  subject: string,
): Promise<void> {
  let current = root;
  for (const component of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in ${subject}s: ${relative(root, current)}`);
    }
  }
}
