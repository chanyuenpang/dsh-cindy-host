/** Static, read-only channel discovery. Never import or execute upstream modules. */
const channel = '[a-z][a-z0-9-]*:[A-Za-z0-9:._-]+';
const stripComments = source => source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, literal) => literal ?? '');

export function literalChannelConstants(source) {
  const found = new Map();
  const pattern = new RegExp('\\b(?:export\\s+)?const\\s+([A-Z][A-Z0-9_]*)\\s*(?::[^=;]+)?=\\s*([\'\"])(' + channel + ')\\2', 'g');
  for (const match of stripComments(source).matchAll(pattern)) found.set(match[1], match[3]);
  return found;
}

export function importedChannelConstants(source, readModule) {
  const found = literalChannelConstants(source);
  for (const match of stripComments(source).matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])(\.[^'"]+)\2/g)) {
    const names = match[1].split(',').map(value => value.trim()).filter(Boolean);
    const wanted = names.map(value => /^([A-Z][A-Z0-9_]*)(?:\s+as\s+([A-Z][A-Z0-9_]*))?$/.exec(value)).filter(Boolean);
    if (!wanted.some(value => /_CHANNEL$/.test(value[1]))) continue;
    const constants = literalChannelConstants(readModule(match[3]));
    for (const [, imported, alias] of wanted) {
      if (constants.has(imported)) found.set(alias ?? imported, constants.get(imported));
      else if (/_CHANNEL$/.test(imported)) found.set(alias ?? imported, null);
    }
  }
  return found;
}

export function referencedChannels(block, constants) {
  const found = new Set();
  const text = stripComments(block);
  for (const match of text.matchAll(new RegExp('([\'\"])(' + channel + ')\\1', 'g'))) found.add(match[2]);
  for (const name of text.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? []) {
    if (!constants.has(name)) continue;
    if (constants.get(name) === null) throw new Error('Cannot statically resolve imported channel constant: ' + name);
    found.add(constants.get(name));
  }
  return found;
}

export function literalChannelCalls(source, desktop = false) {
  const found = new Map();
  const text = stripComments(source);
  const bump = name => found.set(name, (found.get(name) ?? 0) + 1);
  const generic = '(?:<[^;()\\n]*>)?';
  const patterns = desktop
    ? ['\\bt' + generic + '\\(\\s*', '\\binvokeRemote' + generic + '\\(\\s*[^,]+,\\s*']
    : ['\\bcall' + generic + '\\(\\s*'];
  for (const prefix of patterns) {
    for (const match of text.matchAll(new RegExp(prefix + '([\'\"])(' + channel + ')\\1', 'g'))) bump(match[2]);
  }
  return found;
}
