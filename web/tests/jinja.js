// Jinja colouring in the SQL editor: what each piece inside the delimiters is
// taken for, across lines, and that the SQL mode is never shown any of it.
// Run from the repository root: jsc web/tests/jinja.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('const JINJA_KEYWORDS'), src.indexOf("CodeMirror.defineMode('dbt-sql'")));

// The part of CodeMirror's StringStream that jinjaToken uses.
function Stream(s) { this.string = s; this.pos = 0; }
Stream.prototype.eol = function () { return this.pos >= this.string.length; };
Stream.prototype.next = function () { if (!this.eol()) return this.string.charAt(this.pos++); };
Stream.prototype.skipToEnd = function () { this.pos = this.string.length; };
Stream.prototype.eatSpace = function () {
  var start = this.pos;
  while (/\s/.test(this.string.charAt(this.pos))) this.pos++;
  return this.pos > start;
};
Stream.prototype.match = function (pattern, consume) {
  if (typeof pattern === 'string') {
    var ok = this.string.substr(this.pos, pattern.length) === pattern;
    if (ok && consume !== false) this.pos += pattern.length;
    return ok || undefined;
  }
  var m = this.string.slice(this.pos).match(pattern);
  if (m && m.index > 0) return null;
  if (m && consume !== false) this.pos += m[0].length;
  return m;
};

// A stand-in SQL mode: each call takes the rest of what it is shown, and keeps it.
var CodeMirror = { startState: function (mode) { return mode.startState(); } };
var shown;
var sql = {
  startState: function () { return {}; },
  token: function (stream) {
    var from = stream.pos;
    stream.skipToEnd();
    shown.push(stream.string.slice(from));
    return 'sql';
  },
};

// Tokens of a whole text as [text, style], state carried from line to line.
function paint(text) {
  var mode = dbtSqlMode(sql), state = mode.startState(), out = [];
  shown = [];
  text.split('\n').forEach(function (line) {
    var s = new Stream(line);
    while (!s.eol()) {
      var from = s.pos, style = mode.token(s, state);
      if (s.pos === from) { print('FAIL  no progress at "' + line.slice(from) + '"'); return; }
      if (style !== null) out.push([line.slice(from, s.pos), style]);
    }
    if (s.string !== line) print('FAIL  the line was not restored after "' + line + '"');
  });
  return out;
}
function styleOf(tokens, text, nth) {
  var hits = tokens.filter(function (t) { return t[0] === text; });
  var hit = hits[nth || 0];
  return hit ? hit[1] : 'no token "' + text + '"';
}
function check(label, got, want) {
  print((got === want ? 'PASS  ' : 'FAIL  ') + label + (got === want ? '' : '   expected ' + want + ', got ' + got));
}

print('--- SQL outside the delimiters goes to the SQL mode, and only that ---');
var t = paint("select id from {{ ref('stg_orders') }} where 1 = 1");
check('text before a block', styleOf(t, 'select id from '), 'sql');
check('text after a block', styleOf(t, ' where 1 = 1'), 'sql');
check('the opening braces', styleOf(t, '{{'), 'jinja-delim');
check('the closing braces', styleOf(t, '}}'), 'jinja-delim');
check('SQL was shown exactly the SQL', shown.join('|'), 'select id from | where 1 = 1');

t = paint("{# don't colour the rest as a string #}\nselect 'a' as b");
check('an apostrophe in a comment never reaches SQL', shown.join('|'), "select 'a' as b");
t = paint("where name = '{{ var(\"who\") }}'");
check('a quoted block is cut out of the SQL string', shown.join('|'), "where name = '|'");
check('the block inside it is still Jinja', styleOf(t, 'var'), 'jinja-dbt');

print('\n--- what dbt provides reads apart from other calls ---');
t = paint("{{ dbt_utils.star(from=ref('stg_orders'), except=['loaded_at']) }}");
check('ref is dbt', styleOf(t, 'ref'), 'jinja-dbt');
check('a package namespace is a variable', styleOf(t, 'dbt_utils'), 'jinja-var');
check('a package macro is a call', styleOf(t, 'star'), 'jinja-fn');
check('from= is an argument, not the keyword', styleOf(t, 'from'), 'jinja-param');
check('except= is an argument', styleOf(t, 'except'), 'jinja-param');
check('a string', styleOf(t, "'stg_orders'"), 'jinja-string');
check('punctuation', styleOf(t, '('), 'jinja-punct');

t = paint('{{ return(adapter.dispatch("concat", "my_pkg")(fields)) }}');
check('return is dbt', styleOf(t, 'return'), 'jinja-dbt');
check('adapter is dbt', styleOf(t, 'adapter'), 'jinja-dbt');
check('a method after a dot is a call, not dbt', styleOf(t, 'dispatch'), 'jinja-fn');
check('a double-quoted string', styleOf(t, '"concat"'), 'jinja-string');

print('\n--- statements ---');
t = paint("{%- if is_incremental() and var('full', false) %}where x > (select max(x) from {{ this }}){% endif -%}");
check('the tag after {%-', styleOf(t, 'if'), 'jinja-keyword');
check('{%- is one delimiter', styleOf(t, '{%-'), 'jinja-delim');
check('is_incremental is dbt', styleOf(t, 'is_incremental'), 'jinja-dbt');
check('and is a keyword', styleOf(t, 'and'), 'jinja-keyword');
check('false is a constant', styleOf(t, 'false'), 'jinja-atom');
check('SQL between two blocks', styleOf(t, 'where x > (select max(x) from '), 'sql');
check('this is dbt', styleOf(t, 'this'), 'jinja-dbt');
check('endif', styleOf(t, 'endif'), 'jinja-keyword');
check('-%} is one delimiter', styleOf(t, '-%}'), 'jinja-delim');

t = paint("{% set names = cols | map(attribute='name') | list if cols else set([]) %}");
check('set as the tag', styleOf(t, 'set'), 'jinja-keyword');
check('set called later is dbt', styleOf(t, 'set', 1), 'jinja-dbt');
check('an assigned name is a variable', styleOf(t, 'names'), 'jinja-var');
check('a filter with arguments', styleOf(t, 'map'), 'jinja-fn');
check('a filter without', styleOf(t, 'list'), 'jinja-fn');
check('attribute= is an argument', styleOf(t, 'attribute'), 'jinja-param');

t = paint("{% for node in graph.nodes.values() if (node.resource_type == 'model') %}");
check('graph is dbt', styleOf(t, 'graph'), 'jinja-dbt');
check('an attribute is a variable', styleOf(t, 'nodes'), 'jinja-var');
check('a comparison is not an argument', styleOf(t, 'resource_type'), 'jinja-var');
check('in is a keyword', styleOf(t, 'in'), 'jinja-keyword');

t = paint('{% macro cents(column, scale=2) %}');
check('a macro name is a call', styleOf(t, 'cents'), 'jinja-fn');
check('a default value', styleOf(t, '2'), 'jinja-number');

print('\n--- across lines ---');
t = paint([
  '{{ dbt_utils.union_relations(',
  '    relations=[',
  "        ref('stg_a'),",
  '    ],',
  '    source_column_name=none',
  ') }}',
  'select 1',
].join('\n'));
check('an argument on the next line', styleOf(t, 'relations'), 'jinja-param');
check('a call on a later line', styleOf(t, 'ref'), 'jinja-dbt');
check('an argument after a closed list', styleOf(t, 'source_column_name'), 'jinja-param');
check('none', styleOf(t, 'none'), 'jinja-atom');
check('the block closes', styleOf(t, 'select 1'), 'sql');

print('\n--- comments and strings hide what looks like Jinja ---');
t = paint("{#- ref('x') and {{ this }} -#}select 1");
check('a comment is one token', styleOf(t, "{#-"), 'jinja-comment');
check('its body too', styleOf(t, " ref('x') and {{ this }} -#}"), 'jinja-comment');
check('SQL after it', styleOf(t, 'select 1'), 'sql');
t = paint('{#\nstill a comment }}\n#}select 1');
check('a comment across lines', styleOf(t, 'still a comment }}'), 'jinja-comment');
check('SQL after a long comment', styleOf(t, 'select 1'), 'sql');
t = paint("{{ log('closing }} here', info=true) }}select 1");
check('braces in a string do not close', styleOf(t, "'closing }} here'"), 'jinja-string');
check('an escaped quote stays in the string', styleOf(paint("{{ \"a \\\" b\" }}"), '"a \\" b"'), 'jinja-string');
check('the block still closes after', styleOf(t, 'select 1'), 'sql');
