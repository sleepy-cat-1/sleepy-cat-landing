let selectedVersion = '';


function toggleOptions() {
    document.querySelector('.custom-options').classList.toggle('open');
    document.querySelector('.custom-select').classList.toggle('open');
}

function selectVersion(version) {
    selectedVersion = version;
    document.querySelector('.custom-select').textContent = `Selected: ${version}`;
    toggleOptions();
}

function playGame() {
    if (!selectedVersion) {
        alert('Please select a version to play.');
        return;
    }
    window.location.href = selectedVersion + '/index.html';
}


function redirectToNews() {
    window.location.href = 'news.html';
}

function redirectToClients() {
    window.location.href = 'clients.html';
}
function redirectToServers() {
    window.location.href = 'servers.html';
}
function redirectToMods() {
    window.location.href = 'mods.html';
}
function redirectToMain() {
    window.location.href = 'index.html';
}
document.addEventListener("DOMContentLoaded", function() {
            // Function to get a cookie value by name
            function getCookie(name) {
               let cookieArr = document.cookie.split(";");
               for(let i = 0; i < cookieArr.length; i++) {
                  let cookiePair = cookieArr[i].split("=");
                  if(name === cookiePair[0].trim()) {
                     return decodeURIComponent(cookiePair[1]);
                  }
               }
               return null;
            }

            // Set the username placeholder from the cookie
            let username = getCookie("username");
            if (username != null) {
            
               document.getElementById("profile-name").textContent = username;
            }

             let modMakerKitEnabled = getCookie("modMakerKitEnabled");
            if (modMakerKitEnabled === "true") {
               document.getElementById("modMakerCheckbox").checked = true;
               document.getElementById("modMakerItem").style.display = "flex";
               document.getElementById("apiItem").style.display = "flex";
            } else {
               document.getElementById("modMakerItem").style.display = "none";
               document.getElementById("apiItem").style.display = "none";
            }
         });
function openBlankPage(link) {
          // Open a new blank window or tab
        window.open(link);

}
