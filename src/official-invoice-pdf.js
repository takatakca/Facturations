'use strict';

const { previewDraft } = require('./draft-preview');

const SPECIAL_WINANSI = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

class OfficialInvoicePdfError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'OfficialInvoicePdfError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function winAnsi(value) {
  if (typeof value !== 'string') throw new OfficialInvoicePdfError('INVALID_PDF_TEXT');
  const bytes = [];
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
      continue;
    }
    if (code >= 0xa0 && code <= 0xff) {
      bytes.push(code);
      continue;
    }
    const mapped = SPECIAL_WINANSI.get(code);
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    throw new OfficialInvoicePdfError('UNSUPPORTED_PDF_CHARACTER', 409);
  }
  return Buffer.from(bytes);
}

function literal(value) {
  const source = winAnsi(value);
  let output = '(';
  for (const byte of source) {
    if (byte === 0x28) output += '\\(';
    else if (byte === 0x29) output += '\\)';
    else if (byte === 0x5c) output += '\\\\';
    else if (byte >= 0x20 && byte <= 0x7e) output += String.fromCharCode(byte);
    else output += '\\' + byte.toString(8).padStart(3, '0');
  }
  return output + ')';
}

function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new OfficialInvoicePdfError('INVALID_PDF_AMOUNT');
  }
  return (cents / 100).toFixed(2) + ' CAD';
}

function wrap(value, width) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const output = [];
  for (const paragraph of text.split(/\s*\n\s*/u)) {
    let line = '';
    for (const word of paragraph.split(/\s+/u)) {
      if (word.length > width) {
        if (line) {
          output.push(line);
          line = '';
        }
        for (let index = 0; index < word.length; index += width) {
          output.push(word.slice(index, index + width));
        }
        continue;
      }
      const candidate = line ? line + ' ' + word : word;
      if (candidate.length > width) {
        output.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) output.push(line);
  }
  return output;
}

function validateIssuedInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice) ||
      invoice.status !== 'ISSUED_CONFIRMED' ||
      invoice.deliveryState !== 'NOT_AUTHORIZED' ||
      invoice.provider !== 'WAVE' ||
      typeof invoice.officialInvoiceNumber !== 'string' ||
      typeof invoice.providerInvoiceId !== 'string' ||
      typeof invoice.providerConfirmedAt !== 'string' ||
      !invoice.snapshot || typeof invoice.snapshot !== 'object') {
    throw new OfficialInvoicePdfError('ISSUED_INVOICE_REQUIRED', 409);
  }
  const p = invoice.snapshot;
  const calculated = previewDraft({
    currency: p.currency,
    customer: p.customer,
    invoiceDate: p.invoiceDate,
    dueDate: p.dueDate,
    notes: p.notes,
    lines: Array.isArray(p.lines) ? p.lines.map(line => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
      taxable: line.taxable,
    })) : null,
    taxes: Array.isArray(p.taxes) ? p.taxes.map(tax => ({
      code: tax.code,
      label: tax.label,
      rateMilliPercent: tax.rateMilliPercent,
    })) : null,
  });
  for (const key of ['subtotalCents', 'taxableSubtotalCents', 'taxTotalCents', 'totalCents']) {
    if (p[key] !== calculated[key]) {
      throw new OfficialInvoicePdfError('ISSUED_SNAPSHOT_TOTAL_MISMATCH', 409);
    }
  }
  for (let index = 0; index < calculated.lines.length; index++) {
    if (p.lines[index].lineTotalCents !== calculated.lines[index].lineTotalCents) {
      throw new OfficialInvoicePdfError('ISSUED_SNAPSHOT_LINE_MISMATCH', 409);
    }
  }
  for (let index = 0; index < calculated.taxes.length; index++) {
    if (p.taxes[index].amountCents !== calculated.taxes[index].amountCents) {
      throw new OfficialInvoicePdfError('ISSUED_SNAPSHOT_TAX_MISMATCH', 409);
    }
  }
  return calculated;
}

function validateIssuerProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      profile.state !== 'VERIFIED' ||
      !Number.isSafeInteger(profile.version) || profile.version < 1 ||
      typeof profile.profileHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(profile.profileHash) ||
      typeof profile.legalName !== 'string' ||
      typeof profile.displayName !== 'string' ||
      !Array.isArray(profile.addressLines) || profile.addressLines.length < 1 ||
      typeof profile.city !== 'string' ||
      typeof profile.region !== 'string' ||
      typeof profile.postalCode !== 'string' ||
      typeof profile.countryCode !== 'string' ||
      !Array.isArray(profile.taxRegistrations)) {
    throw new OfficialInvoicePdfError('VERIFIED_ISSUER_PROFILE_REQUIRED', 409);
  }
  const values = [
    profile.legalName,
    profile.displayName,
    ...profile.addressLines,
    profile.city,
    profile.region,
    profile.postalCode,
    profile.countryCode,
    profile.contactEmail || '',
    profile.contactPhone || '',
    profile.profileHash,
  ];
  for (const value of values) if (value) winAnsi(value);
  for (const registration of profile.taxRegistrations) {
    if (!registration || typeof registration !== 'object' ||
        typeof registration.scheme !== 'string' ||
        typeof registration.registrationNumber !== 'string') {
      throw new OfficialInvoicePdfError('INVALID_ISSUER_TAX_REGISTRATION', 409);
    }
    winAnsi(registration.scheme);
    winAnsi(registration.registrationNumber);
  }
  return profile;
}

function buildLines(invoice, snapshot, issuerProfile = null) {
  const lines = [];
  const add = (text, font = 'F1', size = 10, gap = 4) => {
    for (const item of wrap(text, font === 'F3' || font === 'F4' ? 82 : 88)) {
      winAnsi(item);
      lines.push({ text: item, font, size, gap });
    }
  };
  add('GROUPE TAKATAK', 'F2', 15, 8);
  add('FACTURE / INVOICE', 'F2', 18, 10);
  add('Numero officiel / Official number: ' + invoice.officialInvoiceNumber, 'F2', 11, 6);
  add('Fournisseur / Provider: WAVE', 'F1', 9, 3);
  add('Identifiant fournisseur / Provider ID: ' + invoice.providerInvoiceId, 'F3', 8, 7);
  add('Confirmee / Confirmed: ' + invoice.providerConfirmedAt, 'F1', 9, 10);

  if (issuerProfile) {
    add('EMETTEUR VERIFIE / VERIFIED ISSUER', 'F2', 11, 5);
    add(issuerProfile.legalName, 'F2', 10, 3);
    if (issuerProfile.displayName !== issuerProfile.legalName) {
      add('Nom affiche / Display name: ' + issuerProfile.displayName, 'F1', 9, 3);
    }
    issuerProfile.addressLines.forEach(line => add(line, 'F1', 9, 2));
    add(
      issuerProfile.city + ', ' + issuerProfile.region + ' ' +
      issuerProfile.postalCode + ' ' + issuerProfile.countryCode,
      'F1', 9, 3
    );
    if (issuerProfile.contactEmail) {
      add('Courriel / Email: ' + issuerProfile.contactEmail, 'F1', 9, 2);
    }
    if (issuerProfile.contactPhone) {
      add('Telephone / Phone: ' + issuerProfile.contactPhone, 'F1', 9, 2);
    }
    issuerProfile.taxRegistrations.forEach(registration => {
      add(
        registration.scheme + ': ' + registration.registrationNumber,
        'F3', 8, 2
      );
    });
    add(
      'Profil emetteur / Issuer profile v' + issuerProfile.version,
      'F3', 7, 2
    );
    add(
      'SHA-256: ' + issuerProfile.profileHash,
      'F3', 7, 8
    );
  }

  add('CLIENT / CUSTOMER', 'F2', 11, 5);
  add(snapshot.customer.name, 'F1', 10, 3);
  add(snapshot.customer.email, 'F1', 9, 3);
  if (snapshot.customer.address) add(snapshot.customer.address, 'F1', 9, 8);

  add('DATES', 'F2', 11, 5);
  add('Date facture / Invoice date: ' + snapshot.invoiceDate, 'F1', 9, 3);
  add('Echeance / Due date: ' + snapshot.dueDate, 'F1', 9, 10);

  add('DETAILS', 'F2', 11, 5);
  snapshot.lines.forEach((line, index) => {
    add(String(index + 1) + '. ' + line.description, 'F2', 9, 2);
    add(
      '   ' + line.quantity + ' x ' + money(line.unitPriceCents) +
      (line.discountCents ? ' - rabais/discount ' + money(line.discountCents) : '') +
      ' = ' + money(line.lineTotalCents),
      'F3', 8, 5
    );
  });

  add('Sous-total / Subtotal: ' + money(snapshot.subtotalCents), 'F4', 9, 3);
  snapshot.taxes.forEach(tax => {
    const rate = (tax.rateMilliPercent / 1000).toFixed(3);
    add(tax.label + ' (' + tax.code + ') ' + rate + '%: ' + money(tax.amountCents), 'F3', 8, 3);
  });
  add('Taxes: ' + money(snapshot.taxTotalCents), 'F4', 9, 3);
  add('TOTAL: ' + money(snapshot.totalCents), 'F4', 12, 10);

  if (snapshot.notes) {
    add('NOTES', 'F2', 11, 5);
    for (const noteLine of wrap(snapshot.notes, 88)) {
      winAnsi(noteLine);
      lines.push({ text: noteLine, font: 'F1', size: 9, gap: 3 });
    }
  }

  add('Document genere depuis le registre immuable ISSUED_CONFIRMED.', 'F1', 7, 2);
  add('Generated from the immutable ISSUED_CONFIRMED registry.', 'F1', 7, 2);
  return lines;
}

function paginate(lines) {
  const pages = [];
  let page = [];
  let used = 0;
  for (const line of lines) {
    const height = line.size + line.gap;
    if (page.length && used + height > 700) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(line);
    used += height;
  }
  if (page.length) pages.push(page);
  return pages;
}

function contentStream(lines, pageNumber, pageCount) {
  let y = 792;
  const commands = ['BT'];
  for (const line of lines) {
    commands.push('/' + line.font + ' ' + line.size + ' Tf');
    commands.push('1 0 0 1 50 ' + y.toFixed(2) + ' Tm');
    commands.push(literal(line.text) + ' Tj');
    y -= line.size + line.gap;
  }
  commands.push('/F1 7 Tf');
  commands.push('1 0 0 1 50 35 Tm');
  commands.push(literal('Page ' + pageNumber + ' / ' + pageCount) + ' Tj');
  commands.push('ET');
  return Buffer.from(commands.join('\n') + '\n', 'ascii');
}

function renderIssuedInvoicePdf(invoice, issuerProfile = null) {
  const snapshot = validateIssuedInvoice(invoice);
  const verifiedIssuer = issuerProfile == null ? null : validateIssuerProfile(issuerProfile);
  const pages = paginate(buildLines(invoice, snapshot, verifiedIssuer));
  const objects = new Map();
  objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'));
  const kids = pages.map((_, index) => (7 + index * 2) + ' 0 R').join(' ');
  objects.set(2, Buffer.from('<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kids + '] >>', 'ascii'));
  objects.set(3, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'ascii'));
  objects.set(4, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'ascii'));
  objects.set(5, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>', 'ascii'));
  objects.set(6, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>', 'ascii'));

  pages.forEach((pageLines, index) => {
    const pageObject = 7 + index * 2;
    const streamObject = pageObject + 1;
    objects.set(pageObject, Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> ' +
      '/Contents ' + streamObject + ' 0 R >>',
      'ascii'
    ));
    const stream = contentStream(pageLines, index + 1, pages.length);
    objects.set(streamObject, Buffer.concat([
      Buffer.from('<< /Length ' + stream.length + ' >>\nstream\n', 'ascii'),
      stream,
      Buffer.from('endstream', 'ascii'),
    ]));
  });

  const maxObject = Math.max(...objects.keys());
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')];
  const offsets = new Array(maxObject + 1).fill(0);
  let offset = chunks[0].length;

  for (let objectNumber = 1; objectNumber <= maxObject; objectNumber++) {
    const body = objects.get(objectNumber);
    if (!body) throw new OfficialInvoicePdfError('PDF_OBJECT_GAP', 500);
    offsets[objectNumber] = offset;
    const object = Buffer.concat([
      Buffer.from(objectNumber + ' 0 obj\n', 'ascii'),
      body,
      Buffer.from('\nendobj\n', 'ascii'),
    ]);
    chunks.push(object);
    offset += object.length;
  }

  const xrefOffset = offset;
  let xref = 'xref\n0 ' + (maxObject + 1) + '\n';
  xref += '0000000000 65535 f \n';
  for (let objectNumber = 1; objectNumber <= maxObject; objectNumber++) {
    xref += String(offsets[objectNumber]).padStart(10, '0') + ' 00000 n \n';
  }
  xref += 'trailer\n<< /Size ' + (maxObject + 1) + ' /Root 1 0 R >>\n';
  xref += 'startxref\n' + xrefOffset + '\n%%EOF\n';
  chunks.push(Buffer.from(xref, 'ascii'));

  const pdf = Buffer.concat(chunks);
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      !pdf.subarray(-8).toString('ascii').includes('%%EOF')) {
    throw new OfficialInvoicePdfError('PDF_RENDER_FAILED', 500);
  }
  return pdf;
}

module.exports = {
  renderIssuedInvoicePdf,
  OfficialInvoicePdfError,
  encodePdfWinAnsi: winAnsi,
};
