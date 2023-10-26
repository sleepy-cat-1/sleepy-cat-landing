if (document.cookie.split(';').some((item) => item.trim().startsWith('banned='))) {
    window.location.href = "/banned.html";
}