import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import DashboardFeedback from './DashboardFeedback';
import {DASHBOARD_LOCALES, DashboardI18nProvider, translateDashboardText} from '../../i18n/dashboard';

assert.equal(renderToStaticMarkup(<DashboardFeedback feedback={null}/>),'');
for (const locale of DASHBOARD_LOCALES) {
 const storage={getItem:()=>locale,setItem:()=>undefined};
 const render=(kind:'success'|'error'|'info',message:string,saving=false)=>renderToStaticMarkup(<DashboardI18nProvider storage={storage}><DashboardFeedback feedback={{kind,message}} saving={saving}/></DashboardI18nProvider>);
 assert.match(render('error','Could not save business settings'),/role="alert"/);
 assert.match(render('success','Business settings saved'),/role="status"/);
 assert.match(render('info','Status'),/aria-atomic="true"/);
 assert.doesNotMatch(render('success','NOT YET SAVED',true),/NOT YET SAVED/,'saving never displays the old result');
 assert.match(render('success','Business settings saved'),/aria-hidden="true"/,'state symbol is decorative; words carry meaning');
 for(const label of ['Done','Close message','No unread notifications','Read issues may still need attention. Check Attention for unresolved issues.','Knowledge added'])if(locale!=='en')assert.notEqual(translateDashboardText(locale,label),label);
}
console.log('State announcements, saving/result separation and six-locale feedback passed.');
