// Fix 245: Mapbox-token voor de Mapbox Streets-kaartlaag (gratis tier, 50.000 weergaves/maand)
// Beveiligd met URL-restricties (alleen bruindav.github.io + raw.githack.com)
export const MAPBOX_TOKEN = "pk.eyJ1IjoiZGlnaWRhdmUiLCJhIjoiY21zczIwOXB4MDZucjJ4cjFtcXRtNWhmdiJ9.VcJPNSy7EzPiNaDUyHAf-w";

// Fix 3 — authDomain terug naar origineel (Cloudflare hosting)
export const firebaseConfig = {
  apiKey: "AIzaSyCgRWejn5vrpFB9znGxte7a_sFWRp-xeYk",
  authDomain: "hornet-mapper.firebaseapp.com",
  projectId: "hornet-mapper",
  storageBucket: "hornet-mapper.firebasestorage.app",
  messagingSenderId: "533861029631",
  appId: "1:533861029631:web:de718960a4a55ea8265eca"
};
