'use strict';

class JobsNotifier {
  constructor() {
    this.handlers = new Map();
  }

  register(channel, handler) {
    if (!channel) {
      throw new Error('channel is required');
    }
    if (typeof handler !== 'function') {
      throw new Error('handler must be a function');
    }

    this.handlers.set(channel, handler);
    return this;
  }

  async send({ channel, target, text, meta = {} }) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }

    return handler({ channel, target, text, meta });
  }
}

module.exports = { JobsNotifier };
