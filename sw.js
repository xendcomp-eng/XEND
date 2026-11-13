/* XEND-CASH service worker: lets the app show notifications from the home-screen app */
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(L){
    for(var i=0;i<L.length;i++){if('focus' in L[i])return L[i].focus()}
    if(self.clients.openWindow)return self.clients.openWindow('./')}))});
/* ready for real push messages later */
self.addEventListener('push',function(e){var d={};try{d=e.data?e.data.json():{}}catch(x){}
  e.waitUntil(self.registration.showNotification(d.title||'XEND-CASH',{body:d.body||'',tag:d.tag||'x',renotify:true}))});
