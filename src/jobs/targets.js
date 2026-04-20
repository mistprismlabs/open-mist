'use strict';

const fs = require('node:fs');

class OwnerTargets {
  constructor({ filePath }) {
    if (!filePath) {
      throw new Error('filePath is required');
    }

    this.filePath = filePath;
  }

  loadAll() {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      if (content.trim() === '') {
        return {};
      }

      return JSON.parse(content);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {};
      }

      throw error;
    }
  }

  get(ownerId) {
    const allTargets = this.loadAll();
    return Object.prototype.hasOwnProperty.call(allTargets, ownerId) ? allTargets[ownerId] : null;
  }
}

module.exports = { OwnerTargets };
