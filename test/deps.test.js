'use strict';

/**
 * 依赖完整性测试：扫描 src/ 下所有 require()/import 的外部包，
 * 验证它们都声明在 package.json 的 dependencies 中。
 *
 * 防止的问题：包被 require 但没写进 package.json，
 * 下次 npm ci 会清除它，部署后 crash。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const NODE_BUILTINS = new Set(builtinModules);

function collectJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      files.push(...collectJsFiles(full));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function extractExternalPackages(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const packages = new Set();

  // require('xxx') or require("xxx")
  const requireRe = /require\(['"]([^./][^'"]*)['"]\)/g;
  // import ... from 'xxx' or import('xxx')
  const importRe = /(?:from|import\()\s*['"]([^./][^'"]*)['"]/g;

  for (const re of [requireRe, importRe]) {
    let match;
    while ((match = re.exec(content)) !== null) {
      let pkg = match[1];
      // Skip node built-ins (node:fs and bare fs)
      if (pkg.startsWith('node:')) continue;
      if (NODE_BUILTINS.has(pkg)) continue;
      // Scoped package: @scope/name → @scope/name
      if (pkg.startsWith('@')) {
        pkg = pkg.split('/').slice(0, 2).join('/');
      } else {
        pkg = pkg.split('/')[0];
      }
      packages.add(pkg);
    }
  }
  return packages;
}

describe('dependency integrity', () => {
  it('all require/import packages are declared in package.json', () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
    );
    const declared = new Set([
      ...Object.keys(pkgJson.dependencies || {}),
      ...Object.keys(pkgJson.devDependencies || {}),
    ]);

    const srcDir = path.join(__dirname, '..', 'src');
    const files = collectJsFiles(srcDir);
    const missing = new Map(); // package → [files]

    for (const file of files) {
      const used = extractExternalPackages(file);
      for (const pkg of used) {
        if (!declared.has(pkg)) {
          const rel = path.relative(path.join(__dirname, '..'), file);
          if (!missing.has(pkg)) missing.set(pkg, []);
          missing.get(pkg).push(rel);
        }
      }
    }

    if (missing.size > 0) {
      const detail = [...missing.entries()]
        .map(([pkg, files]) => `  ${pkg} (used in: ${files.join(', ')})`)
        .join('\n');
      assert.fail(`Undeclared dependencies found:\n${detail}\n\nAdd them to package.json`);
    }
  });
});
