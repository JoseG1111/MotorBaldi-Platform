import asyncio, base64, mimetypes, json
from pathlib import Path
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
ROOT=Path('/mnt/data/MotorBaldi-v12-cinematic-production')
OUT=ROOT/'docs-v12'; OUT.mkdir(exist_ok=True)
def uri(path):
    mime=mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return f'data:{mime};base64,'+base64.b64encode(path.read_bytes()).decode()
def inline_html():
    soup=BeautifulSoup((ROOT/'index.html').read_text(),'html.parser')
    for link in list(soup.find_all('link')):
        href=link.get('href','').split('?',1)[0]
        if 'stylesheet' in link.get('rel',[]) and href.startswith('assets/'):
            tag=soup.new_tag('style'); tag.string=(ROOT/href).read_text(); link.replace_with(tag)
        elif href and not href.startswith(('http','#')): link.decompose()
    codes=[]
    for sc in list(soup.find_all('script')):
        src=sc.get('src','').split('?',1)[0]
        if src.startswith('assets/'):
            code=(ROOT/src).read_text()
            # Replace runtime local image paths used by UI switching.
            for rel in ['assets/images/optimized/lubricantes.webp','assets/images/optimized/repuestos.webp','assets/images/optimized/compra-venta.webp','assets/images/optimized/asistencia.webp','assets/images/optimized/vehiculo-480.webp','assets/images/optimized/motorbaldi-carros-v6-960.webp','assets/images/optimized/motorbaldi-motos-v6-960.webp']:
                code=code.replace(rel,uri(ROOT/rel))
            codes.append(code); sc.decompose()
    for source in soup.find_all('source'): source.decompose()
    for img in soup.find_all('img'):
        src=img.get('src','').split('?',1)[0]; img.attrs.pop('srcset',None)
        if src.startswith('assets/') and (ROOT/src).exists(): img['src']=uri(ROOT/src)
    for code in codes:
        sc=soup.new_tag('script'); sc.string=code; soup.body.append(sc)
    return '<!doctype html>'+str(soup)
HTML=inline_html()
async def shot(page, selector, filename, progress=None):
    if progress is None:
        await page.locator(selector).scroll_into_view_if_needed()
    else:
        top=await page.locator(selector).evaluate('e=>e.offsetTop'); h=await page.locator(selector).evaluate('e=>e.offsetHeight'); vh=await page.evaluate('innerHeight')
        y=top+max(0,h-vh)*progress
        await page.evaluate("y=>scrollTo({top:y,behavior:'instant'})",y)
    await page.wait_for_timeout(220)
    await page.screenshot(path=str(OUT/filename))
async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        out={}
        for name,w,h in [('desktop',1440,900),('mobile',390,844)]:
            page=await browser.new_page(viewport={'width':w,'height':h})
            errs=[]; page.on('pageerror',lambda e,errs=errs:errs.append(str(e))); page.on('console',lambda m,errs=errs:errs.append(m.text) if m.type=='error' else None)
            await page.set_content(HTML,wait_until='load'); await page.wait_for_timeout(1550)
            await page.evaluate("window.open=()=>null")
            data={'ready':await page.evaluate("document.documentElement.classList.contains('motion-v12-ready')"),'overflow':await page.evaluate('document.documentElement.scrollWidth>document.documentElement.clientWidth+1'),'errors':errs}
            await page.evaluate("scrollTo({top:0,behavior:'instant'})"); await page.wait_for_timeout(100); await page.screenshot(path=str(OUT/f'{name}-hero-final.png'))
            if name=='desktop':
                await shot(page,'#servicios',f'{name}-services-final.png',.44)
                data['service']=await page.locator('.service-tab.is-active').get_attribute('data-service')
                await shot(page,'#nosotros',f'{name}-mobility-final.png')
                await shot(page,'#plataforma',f'{name}-platform-final.png',.48)
                await shot(page,'#pioneer-transition',f'{name}-red-final.png',.64)
                data['counter']=await page.locator('.transition-counter b').inner_text()
            else:
                await shot(page,'#pioneer-transition',f'{name}-red-final.png',.62)
                await shot(page,'#nosotros',f'{name}-mobility-final.png')
            out[name]=data
            await page.close()
        await browser.close()
        (OUT/'qa-quick.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
        print(json.dumps(out,ensure_ascii=False,indent=2))
asyncio.run(main())
