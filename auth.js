
// ---- Auth ----
  async function checkAuth() {
    const { data } = await supa.auth.getUser();
    if (data.user) {
      currentUser = data.user;
      $("#userInfo").text(`Logged in as ${currentUser.email}`);
      $("#loginBtn").hide();
      $("#logoutBtn").show();
      await loadWorldFromCloud();
    } else {
      currentUser = null;
      $("#userInfo").text("Not logged in (using local storage)");
      $("#loginBtn").show();
      $("#logoutBtn").hide();
      loadWorldFromLocal();
      renderTiles();
    }
  }

  $("#loginBtn").on("click", async () => {
    const { error } = await supa.auth.signInWithOAuth({
      provider: "google"
    });
    if (error) {
      console.error(error);
      alert("Login failed");
    }
  });

  $("#logoutBtn").on("click", async () => {
    await supa.auth.signOut();
    currentUser = null;
    loadWorldFromLocal();
    renderTiles();
    checkAuth();
  });

  supa.auth.onAuthStateChange((_event, _session) => {
    checkAuth();
  });