LifeWorld — Visual Habit & Growth Tracker

LifeWorld is a lightweight, visual, tile-based personal growth tracker built with HTML, CSS, JavaScript, jQuery UI, and Supabase.
Each action you take in real life updates a tile in your world — forming a gentle, identity-based motivation system.
This repository contains the v0.3 web version, featuring tile management, logging, frequencies, Supabase sync, search, filters, and a modern popup UI.

🚀 Features (v0.3)
✓ 128-Tile Interactive Grid
Click any tile to open the popup
Empty tiles show a + icon
Drag & drop tiles on desktop to reorder (mobile disables dragging automatically)

✓ Tile Details Popup
Editable tile name
Add log entries (saved to history)
Modern Save/Cancel UI
ESC key = Cancel
Click outside popup = Cancel
Auto-loads tile history
New frequency selector (Daily / Weekly / Custom Days)
Custom day selector (Mon–Sun)

✓ Frequency System
Each tile has its own schedule:
Daily
Weekly
Custom days (Mon–Sun combination)
Frequency is used to compute:
When the tile is next due
Quick filter behavior (Today, Tomorrow, 2 Days, 3+ Days)

✓ Search & Quick Filters
Search by tile name or log text
Quick filters:
Today
Tomorrow
2 Days
3+ Days
All tiles

✓ Supabase Cloud Sync
Using:
worlds table
user_id + data JSON structure
If logged in:
Tiles auto-load from cloud
Auto-sync on save
If NOT logged in:
Works offline using LocalStorage
Same tile structure
Auth via Google OAuth.

✓ Responsive UI
Tile layout with auto-fit grid
Mobile scrolling fixed
Drag disabled on mobile for smooth gestures
Header with profile icon
Dropdown login/logout menu

✓ PWA Support (preliminary)
A full icon set and manifest.json are included.
Service worker template installed.
