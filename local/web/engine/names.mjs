const PUFFLE_SUGGESTIONS = ['Atlas', 'Comet', 'Nova', 'Pixel', 'Juniper', 'Echo', 'Maple', 'Orbit', 'Pebble', 'Biscuit', 'Clover', 'Marble',
  'Sprocket', 'Willow', 'Domino', 'Rocket', 'Sunny', 'Quill', 'Basil', 'Indigo', 'Fable', 'Tango', 'Ziggy', 'Bramble', 'Puddle', 'Cosmo',
  'Hazel', 'Mosaic', 'Nimbus', 'Ripple', 'Saffron', 'Topaz'];

function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

// Shared by host validation and the project form.

const PROJECT_CHARS = /^[A-Za-z0-9 ._-]+$/;
const ALNUM = /[A-Za-z0-9]/;

export function projectNameProblem(name) {
  if (typeof name !== 'string' || !name.length) return 'Enter a project name.';
  if (name.length > 30) return 'Project names can be at most 30 characters.';
  if (!PROJECT_CHARS.test(name)) return 'Project names may use only letters, digits, single spaces, hyphens, underscores, and periods.';
  if (!ALNUM.test(name[0]) || !ALNUM.test(name.at(-1))) return 'Project names must begin and end with a letter or digit.';
  if (name.includes('  ')) return 'Project names cannot contain repeated spaces.';
  return null;
}

export function validateProjectName(name) {
  const problem = projectNameProblem(name);
  if (problem) throw invalid(problem);
  return name;
}

export function defaultProjectName(basename) {
  let name = String(basename ?? '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ');
  const trimEdges = value => value.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
  name = trimEdges(trimEdges(name).slice(0, 30));
  return projectNameProblem(name) ? 'Project' : name;
}

export function validatePuffleName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z]{1,12}$/.test(name)) throw invalid('Puffle names must be 1 to 12 letters (A–Z) with no spaces or digits.');
  return name;
}

export function suggestPuffleName(used = []) {
  const taken = new Set(used.map(name => String(name).toLowerCase()));
  return PUFFLE_SUGGESTIONS.find(name => !taken.has(name.toLowerCase())) ?? null;
}
