/**
 * 飞书消息格式转换器（v3）
 *
 * 按语义分段，每段用最合适的飞书卡片组件渲染：
 * - 普通文字/加粗/列表/链接 → tag: "markdown"
 * - 表格 → tag: "table"（原生表格组件）
 * - 分隔线 → tag: "hr"
 * - # 标题 → card header
 */
class MessageFormatter {
  format(text) {
    if (this._isPlainText(text)) {
      return { msg_type: 'text', content: JSON.stringify({ text }) };
    }
    return this._toCard(text);
  }

  _isPlainText(text) {
    if (text.length > 300) return false;
    return !/[#*`|~>\[\]]|^\s*[-+]\s/m.test(text);
  }

  _toCard(text) {
    const { title, body } = this._extractTitle(text);
    const segments = this._parseSegments(body);
    const elements = [];
    const pendingImages = [];

    for (const seg of segments) {
      if (seg.type === 'hr') {
        elements.push({ tag: 'hr' });
      } else if (seg.type === 'table') {
        elements.push(this._buildNativeTable(seg.headers, seg.alignments, seg.dataRows));
      } else if (seg.type === 'image') {
        const imgIndex = pendingImages.length;
        pendingImages.push({ url: seg.url, alt: seg.alt });
        elements.push({
          tag: 'img',
          img_key: `__PENDING_IMG_${imgIndex}__`,
          alt: { tag: 'plain_text', content: seg.alt || '图片' },
          mode: 'fit_horizontal',
          preview: true,
        });
      } else if (seg.content.trim()) {
        // 将内联图片语法转为链接（飞书 markdown 不支持图片语法）
        const cleaned = seg.content.trim().replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[$1]($2)');
        elements.push({ tag: 'markdown', content: cleaned });
      }
    }

    if (elements.length === 0) {
      elements.push({ tag: 'markdown', content: body || text });
    }

    const result = {
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title || 'Jarvis' },
          template: 'blue',
        },
        elements,
      }),
    };

    if (pendingImages.length > 0) {
      result.pendingImages = pendingImages;
    }

    return result;
  }

  _extractTitle(text) {
    const match = text.match(/^#\s+(.+)\n/);
    if (match) {
      return { title: match[1], body: text.slice(match[0].length).trim() };
    }
    return { title: '', body: text };
  }

  /**
   * 将 markdown 文本拆分为语义段：text / table / hr
   */
  _parseSegments(text) {
    const lines = text.split('\n');
    const segments = [];
    let buffer = [];

    const flush = () => {
      if (buffer.length > 0) {
        segments.push({ type: 'text', content: buffer.join('\n') });
        buffer = [];
      }
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // 分隔线
      if (/^-{3,}$|^\*{3,}$/.test(line.trim())) {
        flush();
        segments.push({ type: 'hr' });
        i++;
        continue;
      }

      // 表格检测：当前行以 | 开头，下一行是分隔行 |---|
      if (
        line.trim().startsWith('|') &&
        i + 1 < lines.length &&
        /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())
      ) {
        flush();
        const result = this._consumeTable(lines, i);
        segments.push(result.segment);
        i = result.nextIndex;
        continue;
      }

      // 独立图片行: ![alt](url)
      const imageMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
      if (imageMatch) {
        flush();
        segments.push({ type: 'image', alt: imageMatch[1], url: imageMatch[2] });
        i++;
        continue;
      }

      buffer.push(line);
      i++;
    }

    flush();
    return segments;
  }

  /**
   * 从 lines[start] 开始消费一个 markdown 表格，返回原生表格段和下一行索引
   */
  _consumeTable(lines, start) {
    // 第一行：表头
    const headers = this._splitTableRow(lines[start]);

    // 第二行：对齐/分隔
    const sepCells = this._splitTableRow(lines[start + 1]);
    const alignments = sepCells.map(cell => {
      const trimmed = cell.trim();
      if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
      if (trimmed.endsWith(':')) return 'right';
      return 'left';
    });

    // 第三行起：数据行
    const dataRows = [];
    let i = start + 2;
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      dataRows.push(this._splitTableRow(lines[i]));
      i++;
    }

    return {
      segment: { type: 'table', headers, alignments, dataRows },
      nextIndex: i,
    };
  }

  /**
   * 将 "| a | b | c |" 拆分为 ["a", "b", "c"]
   */
  _splitTableRow(line) {
    return line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
  }

  /**
   * 构建飞书原生 table 组件 JSON
   */
  _buildNativeTable(headers, alignments, dataRows) {
    const columns = headers.map((header, idx) => ({
      name: `c${idx}`,
      display_name: header,
      data_type: 'text',
      width: 'auto',
      horizontal_align: alignments[idx] || 'left',
    }));

    const rows = dataRows.map(cells => {
      const row = {};
      headers.forEach((_, idx) => {
        row[`c${idx}`] = cells[idx] || '';
      });
      return row;
    });

    return {
      tag: 'table',
      page_size: Math.min(Math.max(rows.length, 1), 100),
      row_height: 'low',
      header_style: {
        text_align: 'center',
        text_size: 'normal',
        background_style: 'grey',
        bold: true,
        lines: 1,
      },
      columns,
      rows,
    };
  }
}

module.exports = { MessageFormatter };
