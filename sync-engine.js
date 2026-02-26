
// Exporteer het contextmenu zodat main.js het kan importeren
export function openMapContextMenu(latlng, clientX, clientY) {
  // Eenvoudig demo-menu
  const id = 'mapContextMenu';
  let menu = document.getElementById(id);
  if (!menu) {
    menu = document.createElement('div');
    menu.id = id;
    Object.assign(menu.style, {
      position: 'fixed',
      zIndex: 9999,
      background: '#fff',
      border: '1px solid #ccc',
      borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,.15)',
      padding: '8px 12px',
      fontFamily: 'system-ui, Arial, sans-serif',
      fontSize: '14px'
    });
    document.body.appendChild(menu);
  }
  menu.innerHTML = '';
  const title = document.createElement('div');
  title.textContent = `Kaartpositie: ${latlng?.lat?.toFixed(5)}, ${latlng?.lng?.toFixed(5)}`;
  const close = document.createElement('button');
  close.textContent = 'Sluiten';
  close.onclick = () => menu.remove();
  menu.appendChild(title);
  menu.appendChild(document.createElement('hr'));
  menu.appendChild(close);
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
}
