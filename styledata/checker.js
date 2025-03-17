if (document.cookie.split('; ').find(row => row.startsWith('onekobutton=true'))) {  
    const script = document.createElement('stledata/oneko/oneko.js');
    script.src = 'styledata/oneko/oneko.js';
    document.head.appendChild(script);
  }