'use strict';
// 撤销某一轮的改动：每轮开始前把项目文件夹里的文件存一份（按内容存，一样的只存一次），结束时记下这一轮改了哪些文件、
// 改之前和改之后各是什么内容。撤销就把这些文件放回改之前的样子，「恢复」再放回改之后的样子。
//   <数据文件夹>/checkpoints/<项目 id>/blobs/<前两位>/<sha1>   文件内容
//   <数据文件夹>/checkpoints/<项目 id>/index.json             路径 → { 修改时间, 大小, 内容 }：没变的文件不用再读
// 只管快照里的文件（files.js 的 snapshot：不进 . 开头的文件夹、node_modules 这类）；太大的文件（2 MB 以上）不存，那些文件的改动撤销不了。
// 撤销、恢复时，文件现在的内容要和这一轮结束时（恢复时：撤销以后）一样才动它，之后又被改过的不碰，免得把别人的改动弄丢
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 2 * 1024 * 1024;
const MAX_PASS = 200 * 1024 * 1024; // 一轮最多新读这么多（第一次存一个很大的项目时），再多的就不存了
const MAX_FILES = 500; // 一轮改了这么多文件以上就不记了（多半是装依赖、生成了一大堆东西）

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const rel = (root, p) => path.relative(root, p).replace(/\\/g, '/');

class Checkpoints {
  constructor(dir) {
    this.dir = dir;
    this.indexes = new Map(); // 项目 id → { 相对路径: { m, s, h } }
  }

  home(projectId) {
    return path.join(this.dir, String(projectId).replace(/[^\w-]/g, '_'));
  }

  blobPath(projectId, h) {
    return path.join(this.home(projectId), 'blobs', h.slice(0, 2), h);
  }

  index(projectId) {
    let idx = this.indexes.get(projectId);
    if (!idx) {
      try {
        idx = JSON.parse(fs.readFileSync(path.join(this.home(projectId), 'index.json'), 'utf8')) || {};
      } catch {
        idx = {};
      }
      this.indexes.set(projectId, idx);
    }
    return idx;
  }

  // 把一份内容存起来，返回它的 sha1（已经有了就不再写）
  put(projectId, buf) {
    const h = sha1(buf);
    const f = this.blobPath(projectId, h);
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, f);
    }
    return h;
  }

  get(projectId, h) {
    return fs.readFileSync(this.blobPath(projectId, h));
  }

  // 一轮开始前：快照里的每个文件存一份，返回 { 相对路径: sha1 }（太大、读不了的没有）。修改时间和大小都没变的不用再读
  backup(projectId, root, snap) {
    const idx = this.index(projectId);
    const out = {};
    let read = 0;
    let dirty = false;
    for (const [full, st] of snap.map) {
      const p = rel(root, full);
      const known = idx[p];
      if (known && known.m === st.m && known.s === st.s && fs.existsSync(this.blobPath(projectId, known.h))) {
        out[p] = known.h;
        continue;
      }
      if (st.s > MAX_FILE || read + st.s > MAX_PASS) continue;
      try {
        const buf = fs.readFileSync(full);
        read += buf.length;
        const h = this.put(projectId, buf);
        idx[p] = { m: st.m, s: st.s, h };
        out[p] = h;
        dirty = true;
      } catch {}
    }
    if (dirty) this.saveIndex(projectId);
    return out;
  }

  saveIndex(projectId) {
    const f = path.join(this.home(projectId), 'index.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(this.index(projectId)));
    fs.renameSync(f + '.tmp', f);
  }

  // 一轮结束后：改了哪些文件，每个改之前（before）和改之后（after）的内容。新建的没有 before，删掉的没有 after；
  // 太大存不了的记成 big，撤销时跳过。changes 是 files.diff 的完整清单
  record(projectId, root, changes, before) {
    if (!changes.length || changes.length > MAX_FILES) return null;
    let read = 0;
    const list = changes.map((c) => {
      const e = { path: c.path, change: c.change };
      if (c.change !== 'add') {
        if (before[c.path]) e.before = before[c.path];
        else e.big = true;
      }
      if (c.change !== 'delete') {
        try {
          const full = path.join(root, c.path);
          const st = fs.statSync(full);
          if (st.size > MAX_FILE || read + st.size > MAX_PASS) e.big = true;
          else {
            const buf = fs.readFileSync(full);
            read += buf.length;
            e.after = this.put(projectId, buf);
          }
        } catch {
          e.big = true;
        }
      }
      return e;
    });
    return { files: list };
  }

  // 现在的内容（没有这个文件就是 null）
  current(root, p) {
    try {
      return sha1(fs.readFileSync(path.join(root, p)));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  // 撤销（to = 'before'）或恢复（to = 'after'）：文件现在要和另一头一样才动，不一样的跳过（之后又被改过）。
  // 返回动了哪些、跳过哪些（why：changed 之后又改过，big 太大没存，missing 存的内容找不到了）
  apply(projectId, root, record, to) {
    const from = to === 'before' ? 'after' : 'before';
    const done = [];
    const skipped = [];
    const base = path.resolve(root);
    for (const e of record.files) {
      const full = path.resolve(base, e.path);
      if (full !== base && !full.startsWith(base + path.sep)) continue; // 不出项目文件夹
      if (e.big) {
        skipped.push({ path: e.path, why: 'big' });
        continue;
      }
      try {
        const now = this.current(base, e.path);
        if (now !== (e[from] || null)) {
          skipped.push({ path: e.path, why: 'changed' });
          continue;
        }
        const want = e[to] || null;
        if (want === now) continue;
        if (!want) fs.rmSync(full, { force: true });
        else {
          let buf;
          try {
            buf = this.get(projectId, want);
          } catch {
            skipped.push({ path: e.path, why: 'missing' });
            continue;
          }
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, buf);
        }
        done.push(e.path);
      } catch (err) {
        skipped.push({ path: e.path, why: 'error', error: err.message });
      }
    }
    return { done, skipped };
  }

  // 删项目时一起删
  drop(projectId) {
    this.indexes.delete(projectId);
    fs.rmSync(this.home(projectId), { recursive: true, force: true });
  }

  // 清理：还被哪条消息（撤销记录）或者 index 用着的内容留着，其余的删掉（只删一小时以前的，正在跑的那一轮刚存的不动）。
  // keep：项目 id → Set(sha1)；不在 keep 里的项目整个删掉（项目已经没了）
  gc(keep) {
    let ents = [];
    try {
      ents = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return;
    }
    const old = Date.now() - 3600e3;
    for (const d of ents) {
      if (!d.isDirectory()) continue;
      const pid = Object.keys(keep).find((id) => path.basename(this.home(id)) === d.name);
      if (!pid) {
        fs.rmSync(path.join(this.dir, d.name), { recursive: true, force: true });
        continue;
      }
      const used = new Set(keep[pid]);
      for (const e of Object.values(this.index(pid))) used.add(e.h);
      const blobs = path.join(this.dir, d.name, 'blobs');
      let subs = [];
      try {
        subs = fs.readdirSync(blobs);
      } catch {}
      for (const s of subs) {
        let names = [];
        try {
          names = fs.readdirSync(path.join(blobs, s));
        } catch {}
        for (const n of names) {
          const f = path.join(blobs, s, n);
          try {
            if (!used.has(n) && fs.statSync(f).mtimeMs < old) fs.rmSync(f, { force: true });
          } catch {}
        }
      }
    }
  }
}

module.exports = { Checkpoints, MAX_FILE };
