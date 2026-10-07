// Renders public/icons/*.png from an inline SVG (walnut square, two tiles, one shut).
// Run: node scripts/build-icons.mjs   (needs the sharp devDependency)
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#2a1c12"/>
  <g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)">
    <rect x="40" y="40" width="432" height="432" rx="90" fill="#150e08" stroke="#5a3b1f" stroke-width="14"/>
    <g transform="rotate(-6 190 270)">
      <rect x="92" y="150" width="170" height="226" rx="22" fill="#cdb98d"/>
      <rect x="92" y="142" width="170" height="226" rx="22" fill="#f6ecd5"/>
      <text x="177" y="294" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="130" text-anchor="middle" fill="#2b1d0e">7</text>
    </g>
    <g transform="rotate(5 340 270)">
      <rect x="258" y="160" width="170" height="216" rx="22" fill="#0b0703"/>
      <rect x="266" y="168" width="154" height="200" rx="16" fill="#1c130a"/>
    </g>
    <rect x="130" y="404" width="252" height="14" rx="7" fill="#f2c25b"/>
  </g>
</svg>`;

mkdirSync('public/icons', { recursive: true });
await sharp(Buffer.from(svg(0))).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(Buffer.from(svg(0))).resize(512, 512).png().toFile('public/icons/icon-512.png');
await sharp(Buffer.from(svg(0.18))).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png');
console.log('icons written');
