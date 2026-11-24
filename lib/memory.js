'use strict';

// Memory in use and free, for the card at the top of the dashboard: the
// computer's RAM, and each NVIDIA graphics card's memory and load, from
// nvidia-smi, which comes with NVIDIA's driver. Read every few seconds in
// the background; a computer without nvidia-smi shows RAM alone.

const os = require('os');
const { execFile } = require('child_process');

const GPU_REFRESH_MS = 5000;

let gpus = [];
let gpuAt = 0;
let gpuPending = false;
let noSmi = false;

// One line per card: index, name, MiB used, MiB total, % busy.
function parseSmi(out) {
  const found = [];
  for (const line of String(out).split(/\r?\n/)) {
    const [index, name, used, total, util] = line.split(',').map((s) => s.trim());
    if (!name || !Number.isFinite(Number(total))) continue;
    found.push({
      index: Number(index),
      name: name.replace(/^NVIDIA\s+/, ''),
      used: Number(used) * 1048576,
      total: Number(total) * 1048576,
      busy: Number.isFinite(Number(util)) ? Number(util) : null,
    });
  }
  return found;
}

function refreshGpus() {
  if (noSmi || gpuPending || Date.now() - gpuAt < GPU_REFRESH_MS) return;
  gpuPending = true;
  const args = ['--query-gpu=index,name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'];
  execFile('nvidia-smi', args, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
    gpuPending = false;
    gpuAt = Date.now();
    // Not there: no NVIDIA card, or no driver. Not asked again this run.
    if (err && err.code === 'ENOENT') noSmi = true;
    if (!err) gpus = parseSmi(stdout);
  });
}

// RAM and graphics memory, as { ram: { used, total }, gpus: [...] }, in bytes.
function snapshot() {
  refreshGpus();
  const total = os.totalmem();
  return { ram: { used: total - os.freemem(), total }, gpus };
}

module.exports = { snapshot, parseSmi };
