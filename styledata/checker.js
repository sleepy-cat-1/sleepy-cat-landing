function checkCookieAndExecuteScript() {
  const cookieName = 'onekot';

  if (document.cookie.split('; ').find(row => row.startsWith(cookieName + '='))) {
    // Cookie exists, load and execute the external JavaScript file
    const script = document.createElement('script');
    script.src = 'oneko/oneko.js'; // Replace with the actual path to your JS file
    script.type = 'text/javascript';
    script.onload = function() {
      // Optional:  Code to run after the external script has loaded
      console.log('External script loaded and executed.');
    };
    document.head.appendChild(script);
  } else {
    // Cookie does not exist
    console.log('Cookie "' + cookieName + '" not found.');
    // Optional:  Code to run if the cookie is not found
  }
}

// Call the function to check the cookie and potentially load the script
checkCookieAndExecuteScript();