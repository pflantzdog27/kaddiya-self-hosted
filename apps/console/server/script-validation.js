import vm from 'node:vm';

// Parse only; never execute instance code. This catches syntax errors but does
// not prove compatibility with the instance's JavaScript engine or APIs.
export function checkScript(source, label = 'script') {
  if (typeof source !== 'string' || !source.trim()) return null;
  try {
    new vm.Script(source, { filename: `${label}.js` });
    return null;
  } catch (err) {
    return `${label} does not parse: ${err.message}`;
  }
}

const SCRIPT_FIELDS = ['script', 'condition', 'client_script', 'script_plain', 'link'];

export function scriptProblems(fields, scriptFields = SCRIPT_FIELDS) {
  const problems = [];
  for (const f of scriptFields) {
    if (typeof fields?.[f] !== 'string' || (scriptFields === SCRIPT_FIELDS && fields[f].length < 20)) continue;
    const problem = checkScript(fields[f], f);
    if (problem) problems.push(problem);
  }
  if (typeof fields?.option_schema === 'string' && fields.option_schema.trim()) {
    try { JSON.parse(fields.option_schema); } catch (err) { problems.push(`option_schema is not valid JSON: ${err.message}`); }
  }
  return problems;
}
