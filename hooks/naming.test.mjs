import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluate, format, splitFile, words } from './naming.mjs';

function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'naming-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const write = (root, file_path) =>
  evaluate({ tool_name: 'Write', tool_input: { file_path } }, { projectDir: root });

describe('helpers', () => {
  it('splits words across styles', () => {
    assert.deepEqual(words('UserProfileCard'), ['user', 'profile', 'card']);
    assert.deepEqual(words('user_profile-card'), ['user', 'profile', 'card']);
    assert.deepEqual(words('HTTPServer'), ['http', 'server']);
  });

  it('formats words into each style', () => {
    assert.equal(format('UserProfile', 'kebab'), 'user-profile');
    assert.equal(format('user-profile', 'pascal'), 'UserProfile');
    assert.equal(format('user-profile', 'camel'), 'userProfile');
    assert.equal(format('UserProfile', 'snake'), 'user_profile');
    assert.equal(format('end to end', 'screaming'), 'END_TO_END');
  });

  it('separates name, roles and extension', () => {
    assert.deepEqual(splitFile('user.service.spec.ts'), {
      prefix: '', name: 'user', roles: ['service', 'spec'], ext: 'ts',
    });
    assert.equal(splitFile('_vars.scss').prefix, '_');
  });
});

describe('language defaults', () => {
  it('requires snake_case for Python and suggests it', () => {
    const r = write(project(), 'app/UserService.py');
    assert.equal(r.block, true);
    assert.equal(r.suggestion, 'app/user_service.py');
  });

  it('turns a dotted Python test into test_*.py', () => {
    assert.equal(write(project(), 'tests/user.test.py').suggestion, 'tests/test_user.py');
  });

  it('turns a dotted Go test into *_test.go', () => {
    assert.equal(write(project(), 'user.test.go').suggestion, 'user_test.go');
  });

  it('requires PascalCase for Java', () => {
    assert.equal(write(project(), 'user_service.java').suggestion, 'UserService.java');
  });

  it('accepts kebab-case TypeScript with role suffixes', () => {
    assert.equal(write(project(), 'src/user-profile.service.spec.ts').block, false);
  });

  it('rejects camelCase TypeScript by default', () => {
    assert.equal(write(project(), 'src/userProfile.ts').suggestion, 'src/user-profile.ts');
  });

  it('rejects uppercase role suffixes', () => {
    assert.equal(write(project(), 'user.Service.ts').suggestion, 'user.service.ts');
  });

  it('requires PascalCase components in .tsx', () => {
    assert.equal(write(project(), 'src/user-card.tsx').suggestion, 'src/UserCard.tsx');
  });

  it('rejects whitespace in names', () => {
    assert.equal(write(project(), 'my file.ts').suggestion, 'my-file.ts');
  });
});

describe('project inference', () => {
  it('follows sibling files over the language default', () => {
    const root = project({ 'src/userCard.ts': '', 'src/orderList.ts': '' });
    assert.equal(write(root, 'src/payment-form.ts').suggestion, 'src/paymentForm.ts');
    assert.equal(write(root, 'src/paymentForm.ts').block, false);
  });

  it('follows kebab-case components in a shadcn-style folder', () => {
    const root = project({ 'ui/button-group.tsx': '', 'ui/date-picker.tsx': '' });
    assert.equal(write(root, 'ui/text-area.tsx').block, false);
    assert.equal(write(root, 'ui/TextArea.tsx').suggestion, 'ui/text-area.tsx');
  });

  it('follows SCREAMING_SNAKE docs like this repository', () => {
    const root = project({ 'docs/END_TO_END.md': '', 'docs/UNIT_TESTING.md': '' });
    assert.equal(write(root, 'docs/smoke-testing.md').suggestion, 'docs/SMOKE_TESTING.md');
  });

  it('allows camelCase React hooks', () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: { react: '1' } }) });
    assert.equal(write(root, 'src/useAuth.ts').block, false);
  });

  it('allows Next.js reserved route files', () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: { next: '1' } }) });
    assert.equal(write(root, 'app/dashboard/page.tsx').block, false);
    assert.equal(write(root, 'app/not-found.tsx').block, false);
  });

  it('checks new directories on the path', () => {
    const r = write(project(), 'src/UserProfile/user-card.ts');
    assert.equal(r.block, true);
    assert.equal(r.suggestion, 'src/user-profile/user-card.ts');
  });
});

describe('exemptions', () => {
  it('ignores existing files', () => {
    const root = project({ 'BadName.ts': '' });
    assert.equal(write(root, 'BadName.ts').block, false);
  });

  it('ignores special names and dynamic segments', () => {
    const root = project();
    for (const f of ['Dockerfile', '.eslintrc.json', 'pkg/__init__.py', 'app/[slug]/Item.svelte',
      'src/routes/+page.svelte', 'README.md', 'src/index.tsx', '_vars.scss']) {
      assert.equal(write(root, f).block, false, f);
    }
  });

  it('ignores files outside the project and non-Write tools', () => {
    assert.equal(write(project(), '/elsewhere/BadName.ts').block, false);
    assert.equal(evaluate({ tool_name: 'Edit', tool_input: { file_path: 'Bad.ts' } }).block, false);
  });

  it('honours .claude/naming.json', () => {
    const root = project({
      '.claude/naming.json': JSON.stringify({
        extensions: { ts: 'camel' }, allow: ['LEGACY'], ignore: ['generated/**'],
      }),
    });
    assert.equal(write(root, 'userCard.ts').block, false);
    assert.equal(write(root, 'LEGACY.ts').block, false);
    assert.equal(write(root, 'generated/Whatever_Thing.ts').block, false);
    assert.equal(write(root, 'user-card.ts').suggestion, 'userCard.ts');
  });
});
