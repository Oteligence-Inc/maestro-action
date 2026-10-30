import {
  DEPTH_MAX,
  SETTINGS_MAX,
  argumentSetting,
  commandLineSettings,
  MalformedEscape,
  documents,
  envValue,
  extract,
  keyPathNames,
  kindOf,
  property,
  replaceTemplates,
  untemplated,
} from '../../src/logPolicy/extract';
import { NAME, RuleSet } from '../../src/ciRules';
import { findingsOf } from '../../src/steps/ciCheck';
import cases from '../fixtures/ci-rules/evaluation-cases.json';

const lockFreeRules = (): RuleSet =>
  Object.values((cases as unknown as { ruleSets: Record<string, RuleSet> }).ruleSets).find((s) => s.lockFree) as RuleSet;

const names = (text: string, kind: Parameters<typeof extract>[2], path = 'deploy/x') =>
  extract(path, text, kind).settings.map((s) => `${s.name}=${s.value}@${s.line}`);

describe('which files the check reads', () => {
  it.each([
    ['deploy/values-prod.yaml', 'yaml'],
    ['docker-compose.yml', 'yaml'],
    ['Dockerfile', 'dockerfile'],
    ['images/api.Dockerfile', 'dockerfile'],
    ['Dockerfile.prod', 'dockerfile'],
    ['Containerfile', 'dockerfile'],
    ['.env', 'env'],
    ['config/prod.env', 'env'],
    ['.env.production', 'env'],
    ['config/application-prod.properties', 'properties'],
  ])('reads %s as %s', (p, kind) => {
    expect(kindOf(p)).toBe(kind);
  });

  it.each(['README.md', 'src/Main.java', 'pom.xml', '.envrc', 'values.yaml.bak'])('does not read %s', (p) => {
    expect(kindOf(p)).toBeNull();
  });
});

describe('.env files', () => {
  it('reads assignments, export and quotes, and skips comments', () => {
    expect(names('# DEBUG=true\nexport LOGGING_LEVEL_ROOT="DEBUG"\nOTEL_JAVAAGENT_DEBUG=true\n\nnot a line\n', 'env')).toEqual([
      'logging.level.root=DEBUG@2',
      'otel.javaagent.debug=true@3',
    ]);
  });
});

describe('Dockerfiles', () => {
  it('reads ENV in both forms', () => {
    expect(names('FROM x\nENV LOGGING_LEVEL_ROOT=DEBUG DEBUG=true\nENV OTEL_LOGS_EXPORTER otlp\n', 'dockerfile')).toEqual([
      'logging.level.root=DEBUG@2',
      'debug=true@2',
      'otel.logs.exporter=otlp@3',
    ]);
  });

  it('reads -D and -- arguments of a CMD or ENTRYPOINT, in exec and shell form, across continuations', () => {
    const text = [
      'FROM x',
      'ENTRYPOINT ["java", "-Dotel.javaagent.debug=true", "-jar", "app.jar", "--debug"]',
      'CMD java \\',
      '  -Dlogging.level.com.acme=TRACE -jar app.jar',
    ].join('\n');
    expect(names(text, 'dockerfile')).toEqual(['otel.javaagent.debug=true@2', 'debug=@2', 'logging.level.com.acme=TRACE@3']);
  });

  it('names a CMD that is not a JSON array as a problem, by line', () => {
    const out = extract('Dockerfile', 'FROM x\nCMD ["java", "-Dsecret=hunter2"\n', 'dockerfile');
    expect(out.problems).toEqual([{ path: 'Dockerfile', line: 2, reason: 'CMD is not a JSON array of strings' }]);
    expect(JSON.stringify(out.problems)).not.toContain('hunter2');
  });
});

describe('command lines', () => {
  it('reads -Dk=v, a bare -Dk, --k=v and --k, and nothing else', () => {
    expect(commandLineSettings('-Xmx1g -Da.b=1 -Dflag --spring.profiles.active=debug,prod --debug -jar x.jar')).toEqual([
      { name: 'a.b', value: '1' },
      { name: 'flag', value: '' },
      { name: 'spring.profiles.active', value: 'debug,prod' },
      { name: 'debug', value: '' },
    ]);
  });

  it('keeps a quoted value whole', () => {
    expect(commandLineSettings(`-Dotel.resource.attributes="a=1 b=2" '-Dx=y z'`)).toEqual([
      { name: 'otel.resource.attributes', value: 'a=1 b=2' },
      { name: 'x', value: 'y z' },
    ]);
  });
});

describe('YAML', () => {
  it("reads a Kubernetes container's env entries and args", () => {
    const text = [
      'spec:',
      '  containers:',
      '    - name: orders',
      '      args: ["--debug", "-Dlogging.level.root=DEBUG"]',
      '      env:',
      '        - name: LOGGING_LEVEL_COM_ACME',
      '          value: TRACE',
      '        - name: FROM_A_SECRET',
      '          valueFrom: {secretKeyRef: {name: s, key: k}}',
    ].join('\n');
    const read = names(text, 'yaml');
    expect(read).toContain('debug=@4');
    expect(read).toContain('logging.level.root=DEBUG@4');
    expect(read).toContain('logging.level.com.acme=TRACE@7');
    expect(read.some((r) => r.startsWith('from.a.secret='))).toBe(false);
  });

  it("reads a compose service's environment as a list and as a map", () => {
    const text = [
      'services:',
      '  orders:',
      '    environment:',
      '      - LOGGING_LEVEL_ROOT=DEBUG',
      '  payments:',
      '    environment:',
      '      OTEL_JAVAAGENT_DEBUG: "true"',
    ].join('\n');
    const read = names(text, 'yaml');
    expect(read).toContain('logging.level.root=DEBUG@4');
    expect(read).toContain('otel.javaagent.debug=true@7');
  });

  it("reads a level nested under a chart's own key, and a ConfigMap's environment-style keys", () => {
    const text = ['config:', '  logging:', '    level:', '      root: DEBUG', '---', 'data:', '  LOGGING_LEVEL_ROOT: TRACE'].join('\n');
    const read = names(text, 'yaml');
    expect(read).toContain('logging.level.root=DEBUG@4');
    expect(read).toContain('logging.level.root=TRACE@7');
  });

  it("does not read a lone debug key under another tool's settings", () => {
    expect(names('nginx:\n  debug: true\n', 'yaml')).not.toContain('debug=true@2');
    expect(names('debug: true\n', 'yaml')).toContain('debug=true@1');
  });

  it('expands JAVA_TOOL_OPTIONS and SPRING_APPLICATION_JSON values', () => {
    const text = [
      'env:',
      '  - name: JAVA_TOOL_OPTIONS',
      '    value: "-Dotel.javaagent.debug=true -Xmx1g"',
      '  - name: SPRING_APPLICATION_JSON',
      `    value: '{"logging":{"level":{"root":"DEBUG"}}}'`,
    ].join('\n');
    const read = names(text, 'yaml');
    expect(read).toContain('otel.javaagent.debug=true@3');
    expect(read).toContain('logging.level.root=DEBUG@5');
  });

  it('names SPRING_APPLICATION_JSON that is not JSON as a problem, without its value', () => {
    const out = extract('k.yaml', 'env:\n  - name: SPRING_APPLICATION_JSON\n    value: "{password: hunter2"\n', 'yaml');
    expect(out.problems).toEqual([{ path: 'k.yaml', line: 3, reason: 'SPRING_APPLICATION_JSON is not JSON' }]);
    expect(JSON.stringify(out.problems)).not.toContain('hunter2');
  });

  it('reads a Helm template around its actions, and a templated value reads as a placeholder', () => {
    const text = [
      '{{- if .Values.enabled }}',
      'env:',
      '  - name: LOGGING_LEVEL_ROOT',
      '    value: {{ .Values.level | quote }}',
      '  - name: OTEL_JAVAAGENT_DEBUG',
      '    value: "true"',
      '{{- end }}',
    ].join('\n');
    const out = extract('templates/deploy.yaml', text, 'yaml');
    expect(out.problems).toEqual([]);
    const read = out.settings.map((s) => `${s.name}=${s.value}@${s.line}`);
    expect(read).toContain('logging.level.root=__TEMPLATE__@4');
    expect(read).toContain('otel.javaagent.debug=true@6');
    expect(untemplated('a: {{ x }}')).toBe('a: __TEMPLATE__');
  });

  it('names YAML that does not parse as a problem by line, never its text', () => {
    const out = extract('bad.yaml', 'a: 1\nb: [unclosed, "hunter2"\nc: 3\n', 'yaml');
    expect(out.settings).toEqual([]);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0].path).toBe('bad.yaml');
    expect(out.problems[0].reason).toBe('not valid YAML');
    expect(JSON.stringify(out.problems)).not.toContain('hunter2');
  });

  it('gives the names one key is read as one origin', () => {
    const out = extract('v.yaml', 'otel:\n  instrumentation:\n    jdbc:\n      statement-sanitizer:\n        enabled: false\n', 'yaml');
    const origins = new Set(out.settings.filter((s) => s.name.endsWith('statement.sanitizer.enabled')).map((s) => s.origin));
    expect(origins.size).toBe(1);
  });

  it('keeps a name outside the finding shape, so a finding on it is still made, under a name the platform accepts', () => {
    const text = '"logging.level.com.acme.Outer$Inner": DEBUG\n';
    expect(names(text, 'yaml')).toEqual(['logging.level.com.acme.outer$inner=DEBUG@1']);
    const found = findingsOf(lockFreeRules(), extract('deploy/x', text, 'yaml').settings);
    expect(found.map((f) => f.name)).toEqual(['logging.level.com.acme.outer_inner']);
    expect(found.every((f) => NAME.test(f.name))).toBe(true);
  });
});

describe('key paths', () => {
  it('reads the whole path and each tail of two or more segments', () => {
    expect(keyPathNames(['config', 'logging', 'level', 'root'])).toEqual([
      'config.logging.level.root',
      'logging.level.root',
      'level.root',
    ]);
    expect(keyPathNames(['data', 'LOGGING_LEVEL_ROOT'])).toEqual(['data.LOGGING_LEVEL_ROOT', 'LOGGING_LEVEL_ROOT']);
    expect(keyPathNames(['nginx', 'debug'])).toEqual(['nginx.debug']);
  });
});

describe('.properties files', () => {
  it('reads = : and space separators, continuations and a BOM, and skips comments', () => {
    const text = '﻿logging.level.root=DEBUG\n# debug=true\n! trace=true\nlogging.level.a : TRACE\nlogging.level.b WARN\nlogging.config=\\\n  /etc/log.xml\n';
    expect(names(text, 'properties')).toEqual([
      'logging.level.root=DEBUG@1',
      'logging.level.a=TRACE@4',
      'logging.level.b=WARN@5',
      'logging.config=/etc/log.xml@6',
    ]);
  });
});

describe('lines, as the tools that read the files split them', () => {
  const LS = String.fromCharCode(0x2028);

  it('splits at CRLF, a lone CR and LF', () => {
    expect(names('A=1\r\nLOGGING_LEVEL_ROOT=DEBUG\rDEBUG=true\nB=2', 'env')).toEqual([
      'a=1@1',
      'logging.level.root=DEBUG@2',
      'debug=true@3',
      'b=2@4',
    ]);
    expect(names('a=1\rlogging.level.root=DEBUG\r\n', 'properties')).toEqual(['a=1@1', 'logging.level.root=DEBUG@2']);
    expect(names('FROM x\rENV DEBUG=true\r\n', 'dockerfile')).toEqual(['debug=true@2']);
  });

  it('keeps a line separator inside a value, rather than losing the line', () => {
    expect(names(`LOGGING_LEVEL_ROOT=DEBUG${LS}x\n`, 'env')).toEqual([`logging.level.root=DEBUG${LS}x@1`]);
    expect(names(`ENV LOGGING_LEVEL_ROOT=DEBUG${LS}x\n`, 'dockerfile').length).toBe(1);
  });

  it('reads a file that starts with a byte order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(names(`${bom}DEBUG=true\n`, 'env')).toEqual(['debug=true@1']);
    expect(names(`${bom}ENV DEBUG=true\n`, 'dockerfile')).toEqual(['debug=true@1']);
    expect(names(`${bom}logging.level.root=DEBUG\n`, 'properties')).toEqual(['logging.level.root=DEBUG@1']);
  });
});

describe('a properties line, as java.util.Properties reads it', () => {
  it.each([
    ['logging.level.root=DEBUG', 'logging.level.root', 'DEBUG'],
    ['logging.level.root : DEBUG', 'logging.level.root', 'DEBUG'],
    ['logging.level.root DEBUG', 'logging.level.root', 'DEBUG'],
    ['logging.level.root   =   DEBUG', 'logging.level.root', 'DEBUG'],
    ['a\\:b=c', 'a:b', 'c'],
    ['a\\ b=c', 'a b', 'c'],
    ['debug', 'debug', ''],
    ['password hunter2 more', 'password', 'hunter2 more'],
    ['k==v', 'k', '=v'],
    ['logging.level.\\u0072oot=\\u0044EBUG', 'logging.level.root', 'DEBUG'],
    ['a=\\t\\n\\r\\fx', 'a', '\t\n\r\fx'],
    ['a=f\\alse', 'a', 'false'],
    ['a=DEBUG  ', 'a', 'DEBUG  '],
    ['a=\\', 'a', ''],
    ['\\u00e9=x', '\u00e9', 'x'],
    ['a=\\uD83D\\uDE00', 'a', '\uD83D\uDE00'],
  ])('reads %s as key %s', (line, key, value) => {
    expect(property(line)).toEqual({ key, value });
  });

  it.each(['a=\\u00', 'a=\\u00G1', '\\uZZZZ=x'])('refuses the malformed escape in %s', (line) => {
    expect(() => property(line)).toThrow(MalformedEscape);
  });

  it('never takes a whole line as a key, so a value never reaches a name', () => {
    expect(names('spring.datasource.password hunter2\n', 'properties')).toEqual(['spring.datasource.password=hunter2@1']);
    const ls = String.fromCharCode(0x2028);
    const out = extract('a.properties', `otel.exporter.otlp.headers=Authorization=Bearer hunter2${ls}x\n`, 'properties');
    expect(out.settings.map((x) => x.name)).toEqual(['otel.exporter.otlp.headers']);
  });

  it('continues a line on an odd run of backslashes only', () => {
    expect(names('a=x\\\\\nlogging.level.root=DEBUG\n', 'properties')).toEqual(['a=x\\@1', 'logging.level.root=DEBUG@2']);
    expect(names('a=x\\\nlogging.level.root=DEBUG\n', 'properties')).toEqual(['a=xlogging.level.root=DEBUG@1']);
  });
});

describe('exec-form commands', () => {
  it("reads a shell command line inside a CMD's elements", () => {
    expect(names('CMD ["sh", "-c", "java -Dlogging.level.root=DEBUG -jar app.jar"]\n', 'dockerfile')).toEqual([
      'logging.level.root=DEBUG@1',
    ]);
  });

  it('reads an element that is one argument whole, spaces and all', () => {
    expect(names('ENTRYPOINT ["java", "-Dspring.profiles.active=a b", "-jar", "x.jar"]\n', 'dockerfile')).toEqual([
      'spring.profiles.active=a b@1',
    ]);
    expect(argumentSetting('--debug')).toEqual({ name: 'debug', value: '' });
    expect(argumentSetting('java')).toBeNull();
  });

  it("reads a container's command list the same way", () => {
    expect(names('command: ["sh", "-c", "java -Dlogging.level.root=DEBUG -jar app.jar"]\n', 'yaml')).toContain(
      'logging.level.root=DEBUG@1',
    );
  });
});

describe('environment maps', () => {
  it.each(['environment', 'env', 'data', 'stringData'])('reads a one-word variable under %s', (key) => {
    expect(names(`x:\n  ${key}:\n    DEBUG: "true"\n`, 'yaml')).toContain('debug=true@3');
  });

  it("still does not read a lone debug key under another tool's key", () => {
    expect(names('tool:\n  debug: true\n', 'yaml')).not.toContain('debug=true@2');
    expect(keyPathNames(['services', 'api', 'environment', 'DEBUG'])).toContain('DEBUG');
  });
});

describe('Helm templates', () => {
  it('keeps line numbers past an action that spans lines', () => {
    const text = 'a: {{ include "x"\n  . }}\nlogging:\n  level:\n    root: DEBUG\n';
    expect(untemplated(text).split('\n')).toHaveLength(text.split('\n').length);
    expect(names(text, 'yaml')).toContain('logging.level.root=DEBUG@5');
  });

  it('removes a whole-line action, and keeps a key whose value is one', () => {
    expect(untemplated('{{- if .Values.x }}\n- {{ include "y" . }}\nk: {{ .Values.k }}\n')).toBe('\n\nk: __TEMPLATE__\n');
    expect(untemplated('{{- end }} {{- end }}\n{{ include "x" (dict "k" "a:b") }}\n')).toBe('\n\n');
  });

  it('reads a long run of spaces before a line separator in linear time', () => {
    const ls = String.fromCharCode(0x2028);
    const started = Date.now();
    extract('a.properties', 'a' + ' '.repeat(2000) + 'b' + ls + 'c\n', 'properties');
    extract('Dockerfile', 'ENV' + ' '.repeat(30000) + 'b' + ls + 'c\n', 'dockerfile');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('JVM options and Spring JSON', () => {
  it('reads _JAVA_OPTIONS as a JVM command line', () => {
    expect(names('_JAVA_OPTIONS=-Dlogging.level.root=DEBUG\n', 'env')).toContain('logging.level.root=DEBUG@1');
  });

  it('reads the rest of SPRING_APPLICATION_JSON around a placeholder', () => {
    expect(names('SPRING_APPLICATION_JSON={"logging.level.root":"DEBUG","x":"${X}"}\n', 'env')).toContain(
      'logging.level.root=DEBUG@1',
    );
    expect(names('SPRING_APPLICATION_JSON={"n":${N},"logging.level.root":"DEBUG"}\n', 'env')).toContain(
      'logging.level.root=DEBUG@1',
    );
  });
});

describe('bounds', () => {
  it('does not read an example env file', () => {
    for (const p of ['.env.example', '.env.sample', '.env.template', 'deploy/prod.env.example']) expect(kindOf(p)).toBeNull();
  });

  it('reads a Dockerfile whose name ends like an example env file', () => {
    expect(kindOf('deploy/Dockerfile.env.example')).toBe('dockerfile');
  });

  it('names a file past the settings bound and reads up to it', () => {
    const out = extract('big.env', 'A=1\n'.repeat(SETTINGS_MAX + 5), 'env');
    expect(out.settings).toHaveLength(SETTINGS_MAX);
    expect(out.problems).toEqual([{ path: 'big.env', line: SETTINGS_MAX + 1, reason: expect.stringContaining('more than') }]);
  });

  it('names YAML nested past the depth bound, and reads what is above it', () => {
    let text = 'debug: "true"\n';
    for (let i = 0; i < DEPTH_MAX + 5; i++) text += `${'  '.repeat(i)}k${i}:\n`;
    text += `${'  '.repeat(DEPTH_MAX + 5)}v: 1\n`;
    const out = extract('deep.yaml', text, 'yaml');
    expect(out.problems.map((p) => p.reason)).toEqual([expect.stringContaining('nested deeper')]);
    expect(out.settings.map((s) => s.name)).toContain('debug');
  });
});

describe('YAML documents and compose env values, as the CLI reads them', () => {
  it('reads the documents after one that does not parse', () => {
    const text = 'a: "oops\n---\nlogging:\n  level:\n    root: DEBUG\n';
    const out = extract('v.yaml', text, 'yaml');
    expect(out.settings.map((s) => `${s.name}@${s.line}`)).toContain('logging.level.root@5');
    expect(out.problems).toEqual([{ path: 'v.yaml', line: expect.any(Number), reason: 'not valid YAML' }]);
  });

  it('keeps a directive with the document after it', () => {
    expect(documents('%YAML 1.2\n---\na: 1\n---\nb: 2\n').map((d) => d.start)).toEqual([0, 3]);
    const versioned = '%YAML 1.2\n# header\n---\nlogging:\n  level:\n    root: DEBUG\n';
    expect(extract('v.yaml', versioned, 'yaml').problems).toEqual([]);
    expect(names(versioned, 'yaml')).toContain('logging.level.root=DEBUG@6');
    const tagged = '%TAG !e! tag:example.com,2000:\n---\nlogging:\n  level:\n    root: !e!level DEBUG\n';
    expect(extract('v.yaml', tagged, 'yaml').problems).toEqual([]);
    const commented = '%TAG !e! tag:example.com,2000:\n# header\n---\nlogging:\n  level:\n    root: !e!level DEBUG\n';
    expect(extract('v.yaml', commented, 'yaml').problems).toEqual([]);
    expect(names(commented, 'yaml')).toContain('logging.level.root=DEBUG@6');
  });

  it('names a broken document at its first line, as the CLI does', () => {
    expect(extract('v.yaml', 'a: 1\n---\nb: [unclosed\n', 'yaml').problems).toEqual([
      { path: 'v.yaml', line: 2, reason: 'not valid YAML' },
    ]);
  });

  it('blanks a multi-line action after a list dash, reads one sharing its line as a template, and keeps YAML after one', () => {
    const dashed = 'env:\n- {{ include "x" .\n    | nindent 2 }}\nlogging:\n  level:\n    root: DEBUG\n';
    expect(untemplated(dashed).split('\n').slice(1, 3)).toEqual(['', '']);
    const shared = 'a: {{ .Values.a\n  | default "x" }}\nlogging:\n  level:\n    root: DEBUG\n';
    expect(names(shared, 'yaml')).toEqual(expect.arrayContaining(['a=__TEMPLATE__@1', 'logging.level.root=DEBUG@5']));
    const trailing = '{{- if .Values.a\n  }} x: 1\nlogging:\n  level:\n    root: DEBUG\n';
    expect(untemplated(trailing).split('\n')[1]).not.toBe('');
  });

  it('reads the template patterns as the regular expressions read them, in linear time', () => {
    const reference = (t: string, dollar: boolean, strings: boolean) =>
      t.replace(
        new RegExp((strings ? '"[^"]*"|' : '') + (dollar ? '\\$\\{[^}]*\\}|' : '') + '\\{\\{[^}]*\\}\\}', 'g'),
        (m) => (m.startsWith('"') ? m : '<' + m.length + '>'),
      );
    const alphabet = ['{', '}', '$', '"', 'a', '\n'];
    let seed = 7;
    for (let n = 0; n < 2000; n++) {
      let t = '';
      const len = n % 24;
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        t += alphabet[seed % alphabet.length];
      }
      for (const [dollar, strings] of [[false, false], [true, false], [true, true]]) {
        expect(replaceTemplates(t, { dollar, strings }, (m) => '<' + m.length + '>')).toBe(reference(t, dollar, strings));
      }
    }
    const started = Date.now();
    replaceTemplates('{{'.repeat(1 << 19) + '$'.repeat(4) + '{'.repeat(1 << 19), { dollar: true, strings: true }, () => '');
    untemplated('{{}}'.repeat(1 << 18));
    untemplated('{{'.repeat(1 << 17) + 'x');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('keeps an explicitly tagged !!str yes a word, and reads an explicit !!bool yes as true', () => {
    expect(names('b: !!str yes\n', 'yaml')).toEqual(['b=yes@1']);
    expect(names('b: !!bool yes\nc: !!bool Off\nd: ! on\n', 'yaml')).toEqual(['b=true@1', 'c=false@2', 'd=true@3']);
  });

  it('reads every file under one schema whatever version it declares, and wherever the directive stands', () => {
    expect(names('%YAML 1.1\n---\nOTEL_JAVAAGENT_DEBUG: y\nt: 2001-12-14\n', 'yaml')).toEqual([
      'otel.javaagent.debug=y@3',
      't=2001-12-14@4',
    ]);
    const misplaced = 'logging:\n  level:\n    root: DEBUG\n%YAML 1.2\n---\na: 1\n';
    expect(names(misplaced, 'yaml')).toEqual(expect.arrayContaining(['logging.level.root=DEBUG@3', 'a=1@6']));
  });

  it('reads a YAML file whose lines end in a lone CR', () => {
    expect(names('logging:\r  level:\r    root: DEBUG\r', 'yaml')).toContain('logging.level.root=DEBUG@3');
  });

  it('blanks a template comment or condition that spans lines and stands alone', () => {
    const text = '{{/*\n  the chart header\n*/}}\n{{- if and .Values.a\n      .Values.b }}\nlogging:\n  level:\n    root: DEBUG\n{{- end }}\n';
    expect(untemplated(text).split('\n')).toHaveLength(text.split('\n').length);
    expect(extract('t.yaml', text, 'yaml').problems).toEqual([]);
    expect(names(text, 'yaml')).toContain('logging.level.root=DEBUG@8');
  });

  it('reads a plain YAML 1.1 boolean as SnakeYAML and the Kubernetes reader do', () => {
    const text = "OTEL_JAVAAGENT_DEBUG: yes\na: Off\nb: \"yes\"\nc: 'on'\nd: y\ne: YES\n";
    expect(names(text, 'yaml')).toEqual(
      expect.arrayContaining(['otel.javaagent.debug=true@1', 'a=false@2', 'b=yes@3', 'c=on@4', 'd=y@5', 'e=true@6']),
    );
    expect(findingsOf(lockFreeRules(), extract('v.yaml', 'OTEL_JAVAAGENT_DEBUG: yes\n', 'yaml').settings)).not.toEqual([]);
  });

  it('reads an env value as compose does: a quoted one to its quote, an unquoted one to a comment', () => {
    expect(envValue('DEBUG # temporary')).toBe('DEBUG');
    expect(envValue('"DEBUG" # temporary')).toBe('DEBUG');
    expect(envValue('a#b')).toBe('a#b');
    expect(envValue('DEBUG' + String.fromCharCode(0xa0) + '# a no-break space')).toBe('DEBUG');
    expect(envValue("'a # b' # c")).toBe('a # b');
    expect(envValue('"unclosed')).toBe('"unclosed');
    expect(names('LOGGING_LEVEL_ROOT=DEBUG # temporary\n', 'env')).toEqual(['logging.level.root=DEBUG@1']);
  });
});
