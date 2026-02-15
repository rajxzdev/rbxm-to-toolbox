(function(){
  var c=document.getElementById('stars');
  for(var i=0;i<120;i++){
    var s=document.createElement('div');s.className='star';
    s.style.left=Math.random()*100+'%';s.style.top=Math.random()*100+'%';
    s.style.setProperty('--d',(2+Math.random()*4)+'s');
    s.style.setProperty('--o',(0.3+Math.random()*0.7));
    s.style.animationDelay=Math.random()*5+'s';
    var sz=1+Math.random()*2;s.style.width=s.style.height=sz+'px';
    c.appendChild(s);
  }
})();

var verified=false,selectedFile=null;

function toggleHelp(){document.getElementById('helpModal').classList.toggle('show');}
document.getElementById('helpModal').addEventListener('click',function(e){if(e.target===this)toggleHelp();});

function togglePassword(){
  var i=document.getElementById('apiKey'),ic=document.getElementById('eyeIcon');
  if(i.type==='password'){i.type='text';ic.className='fas fa-eye-slash';}
  else{i.type='password';ic.className='fas fa-eye';}
}

function showToast(m,t){
  t=t||'info';var c=document.getElementById('toastContainer'),d=document.createElement('div');
  d.className='toast '+t;
  d.innerHTML='<i class="fas fa-'+({success:'check-circle',error:'exclamation-circle',info:'info-circle'}[t]||'info-circle')+'"></i><span>'+m+'</span>';
  c.appendChild(d);setTimeout(function(){d.classList.add('out');setTimeout(function(){d.remove();},300);},3500);
}

function verifyCredentials(){
  var uid=document.getElementById('userId').value.trim();
  var key=document.getElementById('apiKey').value.trim();
  var btn=document.getElementById('verifyBtn');
  var r=document.getElementById('verifyResult');

  if(!uid){showToast('Enter User ID','error');return;}
  if(!/^\d+$/.test(uid)){showToast('Must be number','error');return;}
  if(!key){showToast('Enter API Key','error');return;}

  btn.classList.add('loading');btn.disabled=true;
  r.className='verify-result';r.style.display='none';
  showToast('Verifying...','info');

  var x=new XMLHttpRequest();
  x.timeout=15000;
  x.open('GET','/api/verify?uid='+encodeURIComponent(uid)+'&key='+encodeURIComponent(key));

  x.ontimeout=function(){
    btn.classList.remove('loading');btn.disabled=false;
    r.className='verify-result error show';
    r.innerHTML='<i class="fas fa-exclamation-circle"></i><div>Timeout</div>';
    showToast('Timeout','error');
  };

  x.onreadystatechange=function(){
    if(x.readyState!==4)return;
    btn.classList.remove('loading');btn.disabled=false;

    if(x.status===0){
      r.className='verify-result error show';
      r.innerHTML='<i class="fas fa-exclamation-circle"></i><div>Cannot connect</div>';
      showToast('Connection failed','error');
      return;
    }

    var d;
    try{d=JSON.parse(x.responseText);}catch(e){
      r.className='verify-result error show';
      r.innerHTML='<i class="fas fa-exclamation-circle"></i><div>Bad response</div>';
      return;
    }

    if(x.status>=200&&x.status<300&&d.valid){
      verified=true;
      r.className='verify-result success show';
      r.innerHTML='<i class="fas fa-check-circle"></i><div><strong>Verified!</strong> Welcome, '+d.displayName+'</div>';
      document.getElementById('step1Status').innerHTML='<i class="fas fa-check-circle" style="color:var(--success)"></i>';
      var s2=document.getElementById('step2');s2.classList.remove('locked');s2.classList.add('unlocked');
      var lb=document.getElementById('lock2');if(lb)lb.style.display='none';
      showToast('Verified!','success');
    }else{
      r.className='verify-result error show';
      r.innerHTML='<i class="fas fa-exclamation-circle"></i><div>'+(d.error||'Failed')+'</div>';
      showToast(d.error||'Failed','error');
    }
  };

  x.send();
}

var dz=document.getElementById('dropZone'),fi=document.getElementById('fileInput');
dz.addEventListener('click',function(){fi.click();});
dz.addEventListener('dragover',function(e){e.preventDefault();dz.classList.add('dragover');});
dz.addEventListener('dragleave',function(){dz.classList.remove('dragover');});
dz.addEventListener('drop',function(e){e.preventDefault();dz.classList.remove('dragover');if(e.dataTransfer.files.length)handleFile(e.dataTransfer.files[0]);});
fi.addEventListener('change',function(e){if(e.target.files.length)handleFile(e.target.files[0]);});

function handleFile(f){
  var exts=['.rbxm','.rbxmx','.fbx','.obj','.png','.jpg','.jpeg','.mp3','.ogg'];
  var ext='.'+f.name.split('.').pop().toLowerCase();
  if(exts.indexOf(ext)===-1){showToast('Bad format','error');return;}
  if(f.size>50*1024*1024){showToast('Too large','error');return;}
  selectedFile=f;dz.style.display='none';
  document.getElementById('fileInfo').classList.add('show');
  document.getElementById('fileName').textContent=f.name;
  document.getElementById('fileSize').textContent=fmtSize(f.size);
  var tm={'.rbxm':'Model','.rbxmx':'Model','.png':'Decal','.jpg':'Decal','.jpeg':'Decal','.mp3':'Audio','.ogg':'Audio','.fbx':'Mesh','.obj':'Mesh'};
  if(tm[ext])document.getElementById('assetType').value=tm[ext];
  if(!document.getElementById('assetName').value)document.getElementById('assetName').value=f.name.replace(/\.[^.]+$/,'');
  showToast('File ready','success');
}

function removeFile(){selectedFile=null;fi.value='';dz.style.display='';document.getElementById('fileInfo').classList.remove('show');}
function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB';}

function uploadAsset(){
  if(!verified){showToast('Verify first','error');return;}
  if(!selectedFile){showToast('Select file','error');return;}

  var uid=document.getElementById('userId').value.trim();
  var key=document.getElementById('apiKey').value.trim();
  var name=document.getElementById('assetName').value.trim()||selectedFile.name.replace(/\.[^.]+$/,'');
  var type=document.getElementById('assetType').value;
  var desc=document.getElementById('assetDesc').value.trim();

  var btn=document.getElementById('uploadBtn');
  var prog=document.getElementById('progressWrap');
  var bar=document.getElementById('progressBar');
  var ptxt=document.getElementById('progressText');

  btn.classList.add('loading');btn.disabled=true;
  prog.classList.add('show');bar.style.width='10%';ptxt.textContent='Uploading...';

  var fd=new FormData();
  fd.append('file',selectedFile);
  fd.append('userId',uid);
  fd.append('apiKey',key);
  fd.append('assetType',type);
  fd.append('displayName',name);
  fd.append('description',desc||'Uploaded via converter');

  var x=new XMLHttpRequest();
  x.timeout=60000;
  x.open('POST','/api/upload');

  x.upload.onprogress=function(e){if(e.lengthComputable){var p=Math.round((e.loaded/e.total)*60)+10;bar.style.width=p+'%';ptxt.textContent=p+'%';}};

  x.ontimeout=function(){
    btn.classList.remove('loading');btn.disabled=false;prog.classList.remove('show');
    showToast('Timeout','error');
  };

  x.onreadystatechange=function(){
    if(x.readyState!==4)return;
    bar.style.width='100%';btn.classList.remove('loading');btn.disabled=false;

    if(x.status===0){showToast('Connection failed','error');prog.classList.remove('show');return;}

    var d;
    try{d=JSON.parse(x.responseText);}catch(e){showToast('Bad response','error');prog.classList.remove('show');return;}

    var s3=document.getElementById('step3');s3.classList.remove('locked');s3.classList.add('unlocked');
    var lb=document.getElementById('lock3');if(lb)lb.style.display='none';

    if(x.status>=200&&x.status<300&&d.success){
      document.getElementById('resultIcon').innerHTML='<i class="fas fa-check-circle"></i>';
      document.getElementById('resultIcon').className='result-icon success';
      if(d.assetId){
        document.getElementById('resultTitle').textContent='Asset Uploaded!';
        document.getElementById('resultAssetId').textContent=d.assetId;
        document.getElementById('resultInsertUrl').textContent='rbxassetid://'+d.assetId;
        document.getElementById('resultToolboxLink').href='https://www.roblox.com/library/'+d.assetId;
        document.getElementById('toolboxRow').style.display='';
      }else{
        document.getElementById('resultTitle').textContent='Submitted!';
        document.getElementById('resultAssetId').textContent='Check inventory';
        document.getElementById('resultInsertUrl').textContent='Processing...';
        document.getElementById('toolboxRow').style.display='none';
      }
      showToast('Success!','success');
    }else{
      document.getElementById('resultIcon').innerHTML='<i class="fas fa-times-circle"></i>';
      document.getElementById('resultIcon').className='result-icon err';
      document.getElementById('resultTitle').textContent='Failed';
      document.getElementById('resultAssetId').textContent='Error';
      document.getElementById('resultInsertUrl').textContent=d.error||'Unknown';
      document.getElementById('toolboxRow').style.display='none';
      showToast(d.error||'Failed','error');
    }
    s3.scrollIntoView({behavior:'smooth',block:'center'});
    setTimeout(function(){prog.classList.remove('show');bar.style.width='0%';},1000);
  };

  x.send(fd);
}

function copyText(el){
  var c=el.querySelector('code');if(!c)return;var t=c.textContent;
  if(!t||t==='—'||t==='Error')return;
  navigator.clipboard.writeText(t).then(function(){showToast('Copied!','success');});
}

function resetUpload(){
  removeFile();document.getElementById('assetName').value='';
  document.getElementById('assetDesc').value='';document.getElementById('assetType').value='Model';
  var s3=document.getElementById('step3');s3.classList.add('locked');s3.classList.remove('unlocked');
  document.getElementById('resultAssetId').textContent='—';document.getElementById('resultInsertUrl').textContent='—';
  document.getElementById('toolboxRow').style.display='';
  document.getElementById('resultIcon').innerHTML='<i class="fas fa-check-circle"></i>';
  document.getElementById('resultIcon').className='result-icon success';
  document.getElementById('resultTitle').textContent='Asset Uploaded!';
  document.getElementById('step2').scrollIntoView({behavior:'smooth',block:'center'});
  showToast('Ready!','info');
}
