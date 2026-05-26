# Liem Capture — Product Requirements Document (PRD)

## Product Name

Liem Capture

## Tagline

Capture. Drag. Done.

Alternative Taglines:

- The fastest way to share screenshots.
- Screenshot workflow without friction.
- Instant screenshot drag-and-drop for Windows.

---

# 1. Product Vision

Liem Capture is an ultra-lightweight screenshot utility focused on one primary workflow:

> Take screenshot → instantly drag anywhere.

Unlike traditional screenshot tools that rely on clipboard workflows or save dialogs, Liem Capture treats screenshots as temporary draggable visual assets.

The application prioritizes:

- speed
- minimalism
- lightweight performance
- zero friction
- instant sharing

The goal is to make screenshot sharing feel as seamless as dragging a file from the desktop.

---

# 2. Core Product Philosophy

## Principles

- Minimal UI
- Keyboard-first workflow
- Near-instant interactions
- Zero unnecessary menus
- Native-feeling experience
- Lightweight memory usage
- Fast startup
- Beautiful but invisible

## Product Feel

The application should feel:

- premium
- smooth
- native
- fast
- distraction-free

Inspirations:

- CleanShot X
- Raycast
- Linear
- Arc Browser

---

# 3. Target Users

## Primary Users

- developers
- designers
- content creators
- students
- remote workers
- power users

## Common Use Cases

- drag screenshot into Discord
- drag screenshot into WhatsApp Web
- upload screenshot into browser instantly
- move screenshots into folders
- share bugs quickly
- send visual references rapidly

---

# 4. Tech Stack (CRITICAL)

# PRIMARY STACK (MANDATORY)

## Desktop Framework

Tauri v2

Reason:

- extremely lightweight
- low RAM usage
- native performance
- tiny executable size
- significantly lighter than Electron

---

## Backend / Native Layer

Rust

Reason:

- extremely fast
- memory efficient
- excellent OS-level access
- ideal for drag-and-drop + screenshot APIs

---

## Frontend

React + TypeScript

Reason:

- fast development
- modern ecosystem
- maintainable architecture

---

## Styling

TailwindCSS

Reason:

- rapid UI iteration
- minimal CSS overhead
- excellent for utility apps

---

## Animation

Framer Motion

Reason:

- smooth premium animations
- easy microinteraction development

---

# IMPORTANT PERFORMANCE REQUIREMENTS

## Idle RAM Usage

Target:
< 120MB

Stretch Goal:
< 80MB

---

## Startup Time

Target:
< 1 second

---

## Screenshot Delay

Target:
< 100ms

---

## CPU Usage

Near-zero while idle.

---

# 5. Core MVP Features

# 5.1 Region Screenshot Capture

## Hotkey

Default:
Ctrl + Shift + 2

Configurable later.

---

## Capture Flow

1. User presses hotkey
2. Overlay appears
3. User selects region
4. Screenshot captured instantly
5. Floating thumbnail appears bottom-right

---

## MVP Scope

Only:

- region capture

NOT included:

- fullscreen capture
- scrolling capture
- video recording

These come later.

---

# 5.2 Floating Thumbnail System (CORE FEATURE)

This is the heart of the product.

---

## Behavior

After capture:

- thumbnail slides in smoothly
- positioned bottom-right
- auto-dismiss after ~8 seconds
- hover pauses timer

---

## Thumbnail UI

Contains:

- screenshot preview
- subtle shadow
- rounded corners
- close button

---

## Interactions

### Click

Opens lightweight editor.

### Drag

Exports screenshot directly.

### Close

Dismisses thumbnail.

---

# 5.3 Native Drag-and-Drop Export (MOST IMPORTANT FEATURE)

## Product Goal

Users must be able to drag screenshots directly into:

- Discord
- WhatsApp Web
- Telegram
- browser uploads
- folders
- Figma
- Photoshop
- Slack
- Notion

WITHOUT:

- manual save
- opening explorer
- copy-paste workflows

---

# TECHNICAL REQUIREMENTS

During drag:

- create temporary PNG file
  OR
- expose virtual file object through native Windows drag-drop APIs

The dragged item must behave exactly like:
image/png

Target applications must recognize it as a normal image file.

---

# UX REQUIREMENTS

Dragging must feel:

- instant
- smooth
- native
- zero lag

This module is the single most important part of the product.

---

# 5.4 Clipboard Integration

After capture:

- automatically copy image to clipboard

Fallback workflow:
Ctrl + V

---

# 5.5 Temporary Screenshot Storage

## Default Directory

temp/screenshots/

---

## Lifecycle

- screenshots stored temporarily
- auto-delete after 24 hours

Future:

- configurable retention

---

# 5.6 Minimal Screenshot Editor

## MVP Tools

Only:

- arrow
- rectangle
- blur
- text

---

## Important

Editor must remain:

- lightweight
- fast
- uncluttered

DO NOT ADD:

- stickers
- emojis
- templates
- AI generation
- bloated toolbars

---

# 6. User Experience Flow

# Primary Workflow

## Step 1

User presses:
Ctrl + Shift + 2

---

## Step 2

Selection overlay appears.

---

## Step 3

User selects region.

---

## Step 4

Floating thumbnail appears.

---

## Step 5

User drags screenshot directly into:

- Discord
- browser
- folder
- Figma
- WhatsApp
- etc

---

# DONE

No:

- save dialog
- filename prompts
- explorer windows
- unnecessary clicks

---

# 7. UI / UX Design Requirements

# Visual Style

- dark mode first
- glassmorphism subtle
- rounded corners
- soft shadows
- premium utility aesthetic

---

# Animation Style

Animations should be:

- fast
- subtle
- smooth

Avoid:

- flashy effects
- gamer aesthetics
- bouncy animations

Target feel:
macOS-quality utility app on Windows.

---

# 8. Multi Screenshot Behavior

If multiple screenshots are taken:

- thumbnails stack vertically upward
- newest screenshot appears at bottom

Example:

[Shot 3]
[Shot 2]
[Shot 1]

---

# 9. System Architecture

# Core Modules

## Screenshot Engine

Responsibilities:

- region selection
- screen capture
- multi-monitor support

---

## Floating Overlay Manager

Responsibilities:

- thumbnail rendering
- positioning
- stacking logic
- animations

---

## Drag Export Manager

Responsibilities:

- drag lifecycle
- temp file creation
- native drag APIs

THIS IS THE MOST IMPORTANT MODULE.

---

## Temporary Storage Manager

Responsibilities:

- temp cleanup
- lifecycle management
- retention logic

---

## Editor Module

Responsibilities:

- annotations
- rendering
- export

---

# 10. Windows Requirements

## OS Support

Windows 10+
Windows 11

---

## Required Native Features

- global hotkeys
- transparent overlay windows
- click-through overlay support
- native drag-and-drop APIs
- multi-monitor awareness
- DPI scaling support

---

# 11. Things To Avoid

DO NOT:

- become bloated
- add excessive settings
- overload UI
- become ShareX clone
- add unnecessary AI features
- clutter interface

The product must remain:

- fast
- minimal
- focused

---

# 12. Future Features (POST-MVP)

## OCR

Extract text from screenshots instantly.

---

## Scroll Capture

Capture full webpages/chats.

---

## Pin Screenshot

Keep screenshots floating permanently.

---

## Cloud Upload

Generate instant share links.

---

## GIF / Video Capture

Short screen recordings.

---

## AI Features (OPTIONAL)

Possible future ideas:

- auto blur sensitive data
- OCR summarization
- smart naming

These are NOT MVP priorities.

---

# 13. Competitive Positioning

## Snipping Tool

Too clipboard-focused.

---

## ShareX

Too complex and intimidating.

---

## Lightshot

Outdated UX.

---

## CleanShot X

Mac-only.

---

# Liem Capture Positioning

Windows-first ultra-lightweight drag-first screenshot workflow.

---

# 14. Suggested Project Structure

src/
├── core/
│   ├── capture/
│   ├── overlay/
│   ├── dragdrop/
│   ├── temp/
│   └── editor/
│
├── ui/
│   ├── components/
│   ├── animations/
│   └── windows/
│
├── hooks/
├── store/
├── utils/
└── assets/

---

# 15. Branding Direction

## Aesthetic

- matte dark UI
- subtle transparency
- orange accent
- minimal premium look

---

## Logo Ideas

- crop tool icon
- stylized “L”
- cursor + frame hybrid

---

# 16. Success Criteria

The product succeeds if users can:

capture → drag → send

in under:
3 seconds

without thinking.

That is the core product vision.

---

# 17. Engineering Notes (IMPORTANT)

## PRIORITY ORDER

1. screenshot capture
2. floating thumbnail
3. native drag-and-drop

If these three are excellent:
the MVP succeeds.

---

# IMPORTANT IMPLEMENTATION NOTES

## Avoid Electron

Electron is NOT allowed unless absolutely necessary.

Reason:

- excessive RAM usage
- slow startup
- bloated distribution size

Tauri + Rust is mandatory for lightweight performance.

---

## Prefer Native APIs

Use native Windows APIs whenever possible for:

- drag-and-drop
- screenshot capture
- overlays
- hotkeys

Avoid web-based hacks.

---

# FINAL PRODUCT GOAL

Liem Capture should feel like:

- a native Windows utility
- extremely fast
- visually clean
- almost invisible
- addictive to use

The workflow should feel magical:
capture → drag → done
