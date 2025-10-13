// Function to get a cookie value by name
function getCookie(name) {
    let cookieArr = document.cookie.split(";");
    for (let i = 0; i < cookieArr.length; i++) {
        let cookiePair = cookieArr[i].split("=");
        if (name === cookiePair[0].trim()) {
            return decodeURIComponent(cookiePair[1]);
        }
    }
    return null;
}

// Function to update the visibility of navigation items
function updateNavVisibility() {
    let modMakerKitEnabled = getCookie("modMakerKitEnabled");
    if (modMakerKitEnabled === "true") {
        document.getElementById("modMakerItem").style.display = "flex";
        document.getElementById("apiItem").style.display = "flex";
    } else {
        document.getElementById("modMakerItem").style.display = "none";
        document.getElementById("apiItem").style.display = "none";
    }
}

// Call the function on page load
document.addEventListener("DOMContentLoaded", function() {
    updateNavVisibility();
});
function createAbout(url) {

    var win = window.open();
    
    win.document.body.style.margin = '0';
    
    win.document.body.style.height = '100vh';
    
    var iframe = win.document.createElement('iframe');
    
    iframe.style.border = 'none';
    
    iframe.style.width = '100%';
    
    iframe.style.height = '100%';
    
    iframe.style.margin = '0';
    
    iframe.src = url;
    
    win.document.body.appendChild(iframe);
    
    }