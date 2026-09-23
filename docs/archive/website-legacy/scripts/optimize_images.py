"""Regenerate the v6 photos, transparent logo and icons from supplied originals.

Usage: python scripts/optimize_images.py
Optional development dependency: Pillow. No image tools run on the hosting server.
The prepared social preview remains a separate, already-published asset.
"""
from pathlib import Path
import json
import shutil
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
ORIGINALS = ROOT / 'design-originals'
BRAND = ROOT / 'assets/brand'
PHOTOS = ROOT / 'assets/images/optimized'

def main():
    required = [ORIGINALS / f'motorbaldi-{kind}-original.png' for kind in ('logo','carros','motos')]
    for source in required:
        if not source.is_file(): raise FileNotFoundError(f'Missing original: {source}')
    for directory in (BRAND, BRAND/'icons', PHOTOS, ROOT/'docs'):
        directory.mkdir(parents=True, exist_ok=True)
    logo = ImageOps.exif_transpose(Image.open(required[0])).convert('RGBA')
    bounds = logo.getchannel('A').getbbox()
    if bounds is None: raise ValueError('The logo has no visible pixels.')
    logo = logo.crop(bounds)
    logo.save(BRAND/'motorbaldi-logo-v6.webp', 'WEBP', lossless=True, method=6, exact=True)
    logo.save(BRAND/'motorbaldi-logo-v6.png', 'PNG', optimize=True)
    alpha = logo.getchannel('A')
    separation = next((y for y in range(logo.height) if not alpha.crop((0,y,logo.width,y+1)).getbbox()), None)
    if not separation: raise ValueError('Cannot find the gap below the original MB monogram.')
    mark = logo.crop((0,0,logo.width,separation))
    mark = mark.crop(mark.getchannel('A').getbbox())
    mark.save(BRAND/'motorbaldi-mark-v6.png', 'PNG', optimize=True)
    def icon(size):
        canvas = Image.new('RGBA',(size,size),(17,19,19,255))
        fitted = ImageOps.contain(mark,(round(size*.84),round(size*.62)),Image.Resampling.LANCZOS)
        canvas.alpha_composite(fitted,((size-fitted.width)//2,(size-fitted.height)//2))
        return canvas.convert('RGB')
    for size,name in [(32,'favicon-32'),(180,'apple-touch-icon'),(192,'icon-192'),(512,'icon-512')]:
        icon(size).save(BRAND/'icons'/f'{name}-v6.png','PNG',optimize=True)
    icon(256).save(ROOT/'favicon-v6.ico',sizes=[(16,16),(32,32),(48,48),(64,64)])
    shutil.copy2(ROOT/'favicon-v6.ico',ROOT/'favicon.ico')
    report={'logo':{'source_bytes':required[0].stat().st_size,'width':logo.width,'height':logo.height,
                    'webp_bytes':(BRAND/'motorbaldi-logo-v6.webp').stat().st_size},'photos':{}}
    for kind in ('carros','motos'):
        source=ORIGINALS/f'motorbaldi-{kind}-original.png'
        photo=ImageOps.exif_transpose(Image.open(source)).convert('RGB')
        info={'source_bytes':source.stat().st_size,'source_size':list(photo.size),'variants':[]}
        if photo.width<1642: raise ValueError('Source must be at least 1642px wide; do not upscale a small original.')
        for width in (480,960,1642):
            height=round(photo.height*width/photo.width)
            path=PHOTOS/f'motorbaldi-{kind}-v6-{width}.webp'
            photo.resize((width,height),Image.Resampling.LANCZOS).save(path,'WEBP',quality=84,method=6)
            info['variants'].append({'file':str(path.relative_to(ROOT)),'width':width,'height':height,
                                     'bytes':path.stat().st_size,'reduction_pct':round(100*(1-path.stat().st_size/source.stat().st_size),2)})
        report['photos'][kind]=info
    (ROOT/'docs/optimizacion-imagenes.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print('v6 photos, logo and icons regenerated. Run npm run build to update dist/.')

if __name__ == '__main__':
    main()
