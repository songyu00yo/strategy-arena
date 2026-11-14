// Synthetic fixtures only; no user documents or model outputs.
import { crc32 } from "node:zlib";

export function zipFixture(entries: Record<string, string | Buffer>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function docxFixture() {
  return zipFixture({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Example plan</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Budget</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>300</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  });
}

export function pdfFixture(
  pageCount = 1,
  text = true,
  graphic = false,
  encrypted = false,
  raster?: Buffer,
) {
  const objects: string[] = ["", "<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  let imageId = 0;
  if (raster) {
    imageId = objects.length;
    const imageData = raster.toString("hex") + ">";
    objects.push(
      `<< /Type /XObject /Subtype /Image /Width 400 /Height 500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${imageData.length} >>\nstream\n${imageData}\nendstream`,
    );
  }
  for (let page = 0; page < pageCount; page++) {
    const pageId = objects.length;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> ${imageId ? `/XObject << /Im1 ${imageId} 0 R >>` : ""} >> /Contents ${contentId} 0 R >>`,
    );
    const content =
      (text ? `BT /F1 16 Tf 40 400 Td (Example page ${page + 1}) Tj ET\n` : "") +
      (graphic ? "0 0 1 rg 40 40 120 100 re f\n" : "") +
      (imageId ? "q 400 0 0 500 0 0 cm /Im1 Do Q\n" : "");
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`;
  let encryptId = 0;
  if (encrypted) {
    encryptId = objects.length;
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R${encryptId ? ` /Encrypt ${encryptId} 0 R /ID [<0123456789abcdef><0123456789abcdef>]` : ""} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
