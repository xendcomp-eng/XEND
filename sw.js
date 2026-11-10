/* XEND-CASH service worker: lets phones show notifications and opens the app when one is tapped. */
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){if('focus' in list[i])return list[i].focus()}
    return self.clients.openWindow('./');
  }));
});
/* ready for real background push later: shows whatever a push server sends as {title, body} */
self.addEventListener('push',function(e){
  var d={};try{d=e.data?e.data.json():{}}catch(x){}
  e.waitUntil(self.registration.showNotification(d.title||'XEND-CASH',{body:d.body||'',tag:d.tag||'push',renotify:true,vibrate:[120,80,120]}));
});
