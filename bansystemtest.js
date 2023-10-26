document.cookie = "banned=true; expires=Fri, 31 Dec 9999 23:59:59 GMT; path=/";
if (document.cookie.split(';').some((item) => item.trim().startsWith('banned='))) {
    // The user is banned, redirect them or show a message
}