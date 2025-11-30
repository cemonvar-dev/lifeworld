
// ---- Auth ----
  async function checkAuth() {
    const { data } = await supa.auth.getUser();
    if (data.user) {
      currentUser = data.user;
      $("#userInfo").text(`Logged in as ${currentUser.email}`);
      $("#menuLoginBtn").hide();
      $("#menuLogoutBtn").show();
      await loadWorldFromCloud();
    } else {
      currentUser = null;
      $("#userInfo").text("Not logged in (using local storage)");
      $("#menuLoginBtn").show();
      $("#menuLogoutBtn").hide();
      loadWorldFromLocal();
      renderTiles();
    }
  }

  $("#menuLoginBtn").on("click", async () => {
    const { error } = await supa.auth.signInWithOAuth({
      provider: "google"
    });
    if (error) {
      console.error(error);
      alert("Login failed");
    }
  });

  $("#menuLogoutBtn").on("click", async () => {
    await supa.auth.signOut();
    currentUser = null;
    loadWorldFromLocal();
    renderTiles();
    checkAuth();
  });

  supa.auth.onAuthStateChange((_event, _session) => {
    checkAuth();
  });
  
  
// Update profile UI on auth change
function updateProfileUI() {
	if (currentUser) {
		$("#profileEmail").text(currentUser.email);
		$("#menuLoginBtn").hide();
		$("#menuLogoutBtn").show();
	} else {
		$("#profileEmail").text("Guest");
		$("#menuLoginBtn").show();
		$("#menuLogoutBtn").hide();
	}
}

// Hook into your existing checkAuth()
const originalCheck = checkAuth;
checkAuth = async function() {
	await originalCheck();
	updateProfileUI();
};
