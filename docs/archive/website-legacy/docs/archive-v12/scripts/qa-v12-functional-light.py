import asyncio, json, re
from pathlib import Path
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
ROOT=Path('/mnt/data/MotorBaldi-v12-cinematic-production'); OUT=ROOT/'docs-v12'; OUT.mkdir(exist_ok=True)
PIX='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
def html():
 s=BeautifulSoup((ROOT/'index.html').read_text(),'html.parser')
 for link in list(s.find_all('link')):
  href=link.get('href','').split('?',1)[0]
  if 'stylesheet' in link.get('rel',[]) and href.startswith('assets/'):
   t=s.new_tag('style'); t.string=(ROOT/href).read_text(); link.replace_with(t)
  else: link.decompose()
 codes=[]
 for sc in list(s.find_all('script')):
  src=sc.get('src','').split('?',1)[0]
  if src.startswith('assets/'):
   code=(ROOT/src).read_text(); code=re.sub(r"assets/images/[A-Za-z0-9_./-]+\.(?:webp|png|jpg|jpeg)",PIX,code); codes.append(code); sc.decompose()
 for source in s.find_all('source'): source.decompose()
 for im in s.find_all('img'): im['src']=PIX; im.attrs.pop('srcset',None)
 for code in codes:
  t=s.new_tag('script'); t.string=code; s.body.append(t)
 return '<!doctype html>'+str(s)
HTML=html()
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
  pg=await b.new_page(viewport={'width':1440,'height':900}); pg.set_default_timeout(3000)
  errors=[]; pg.on('pageerror',lambda e: errors.append(str(e)))
  await pg.set_content(HTML,wait_until='domcontentloaded'); await pg.wait_for_timeout(1700); await pg.evaluate('window.open=()=>null')
  R={'viewports':{},'interactions':{},'errors':errors}
  for n,w,h in [('320',320,740),('390',390,844),('768',768,1024),('1440',1440,900),('1920',1920,1080)]:
   await pg.set_viewport_size({'width':w,'height':h}); await pg.evaluate('scrollTo(0,0)'); await pg.wait_for_timeout(30)
   maxy=await pg.evaluate('document.documentElement.scrollHeight-innerHeight'); ok=True
   for f in [0,.33,.66,1]:
    await pg.evaluate('(y)=>scrollTo(0,y)',maxy*f); await pg.wait_for_timeout(12); ok &= not await pg.evaluate('document.documentElement.scrollWidth>document.documentElement.clientWidth+1')
   R['viewports'][n]=ok
  await pg.set_viewport_size({'width':1440,'height':900})
  # dispatch manual clicks directly, avoiding animation-stability waits
  await pg.evaluate("document.querySelector('#service-tab-history').click()")
  R['interactions']['service'] = await pg.evaluate("document.querySelector('#service-title').textContent==='Tu vehículo también puede tener memoria.' && document.querySelector('#service-tab-history').getAttribute('aria-selected')==='true'")
  await pg.evaluate("document.querySelector('.vehicle-switch [data-vehicle=moto]').click()")
  R['interactions']['vehicle_to_form']=await pg.evaluate("document.querySelector('input[value=Motocicleta]').checked && document.querySelector('#vehicle-type-label').textContent==='MOTO'")
  await pg.evaluate("let e=document.querySelector('input[value=Automóvil]');e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}))")
  R['interactions']['form_to_vehicle']=await pg.evaluate("document.querySelector('.vehicle-switch [data-vehicle=car]').getAttribute('aria-pressed')==='true'")
  await pg.evaluate("document.querySelector('[data-form-service=\"Información sobre la plataforma\"]').click()")
  await pg.wait_for_timeout(40); R['interactions']['platform_preselect']=await pg.evaluate("document.querySelector('#service').value==='Información sobre la plataforma'")
  await pg.evaluate("document.querySelector('[data-form-service=\"Programa de pioneros MB-100\"]').click()")
  await pg.wait_for_timeout(40); R['interactions']['pioneer_preselect']=await pg.evaluate("document.querySelector('#service').value==='Programa de pioneros MB-100'")
  # validation and valid WhatsApp handoff
  await pg.evaluate("document.querySelector('#service').value='';document.querySelector('#details').value='';document.querySelector('#quote-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
  R['interactions']['validation']=await pg.evaluate("document.querySelector('#service').getAttribute('aria-invalid')==='true' && document.querySelector('#details').getAttribute('aria-invalid')==='true'")
  await pg.evaluate("document.querySelector('#service').value='Mantenimiento';document.querySelector('#details').value='Prueba';document.querySelector('#quote-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
  R['interactions']['whatsapp']=await pg.evaluate("document.querySelector('#whatsapp-fallback').href.startsWith('https://wa.me/573104602615?text=')")
  # menu mobile focus via direct click and Escape
  await pg.set_viewport_size({'width':390,'height':844}); await pg.evaluate('scrollTo(0,0)'); await pg.wait_for_timeout(30)
  await pg.evaluate("let b=document.querySelector('.menu-toggle');b.focus();b.click()")
  R['interactions']['menu_open_focus']=await pg.evaluate("document.querySelector('#mobile-menu').open && document.activeElement.classList.contains('menu-close')")
  await pg.keyboard.press('Escape'); await pg.wait_for_timeout(25)
  R['interactions']['menu_escape_restore']=await pg.evaluate("!document.querySelector('#mobile-menu').open && document.activeElement.classList.contains('menu-toggle')")
  R['interactions']['motion_ready']=await pg.evaluate("document.documentElement.classList.contains('motion-v12-ready')")
  R['interactions']['intro_nonblocking']=await pg.evaluate("getComputedStyle(document.querySelector('.motion-intro')).pointerEvents==='none'")
  # reduced motion
  ctx=await b.new_context(viewport={'width':390,'height':844},reduced_motion='reduce'); rp=await ctx.new_page(); rerr=[]; rp.on('pageerror',lambda e:rerr.append(str(e)))
  await rp.set_content(HTML,wait_until='domcontentloaded'); await rp.wait_for_timeout(100)
  R['reduced']={'class':await rp.evaluate("document.documentElement.classList.contains('reduce-motion')"),'no_overflow':not await rp.evaluate('document.documentElement.scrollWidth>document.documentElement.clientWidth+1'),'intro_hidden':await rp.evaluate("getComputedStyle(document.querySelector('.motion-intro')).display==='none' || parseFloat(getComputedStyle(document.querySelector('.motion-intro')).opacity||0)===0"),'errors':rerr}
  await ctx.close(); await pg.close(); await b.close()
  checks=list(R['viewports'].values())+list(R['interactions'].values())+[R['reduced']['class'],R['reduced']['no_overflow'],R['reduced']['intro_hidden']]
  R['summary']={'passed':sum(map(bool,checks)),'total':len(checks),'failures':sum(not bool(x) for x in checks),'js_errors':len(errors)+len(rerr)}
  (OUT/'qa-functional.json').write_text(json.dumps(R,ensure_ascii=False,indent=2)); print(json.dumps(R,ensure_ascii=False,indent=2))
  raise SystemExit(0 if R['summary']['failures']==0 and R['summary']['js_errors']==0 else 1)
asyncio.run(main())
