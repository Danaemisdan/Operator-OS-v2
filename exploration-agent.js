'use strict';
const http = require('http');

/**
 * EXPLORATION AGENT — comprehensive heuristic classifier
 *
 * Rules: ordered from most-specific to most-generic.
 * Every real-world element type has a named category + human-readable purpose.
 * Zero LLM calls. Fast on every page load.
 */

// ── Element purpose classifier ────────────────────────────────────────────────
function classifyElementPurpose(el) {
  const t          = (el.text        || '').trim();
  const tL         = t.toLowerCase();
  const id         = (el.id          || '').toLowerCase();
  const tag        = (el.tag         || el.type || '').toLowerCase(); // html tag
  const ph         = (el.placeholder || '').toLowerCase();
  const cls        = (el.class       || el.className || '').toLowerCase();
  const href       = (el.href        || '').toLowerCase();         // resolved full href
  const hrefRaw    = (el.hrefRaw     || '').toLowerCase();         // raw href attr (#anchor, /path, javascript:)
  const inputType  = (el.inputType   || '').toLowerCase();         // <input type="...">
  const name       = (el.name        || '').toLowerCase();         // name="q" etc.
  const value      = (el.value       || '').toLowerCase();         // current value / submit button label
  const aria       = (el.ariaLabel   || el['aria-label'] || '').toLowerCase();
  const role       = (el.role        || '').toLowerCase();
  const parent     = (el.parentContext || '').toLowerCase();
  const hasChildren= !!el.hasChildren;                             // contains interactive children

  // Combine all text signals for keyword checks
  const combined = [tL, ph, aria, name, id, value].join(' ');

  // ── inputType-based routing (most reliable signal) ────────────────────────
  // Route by the actual HTML type= attribute FIRST, before any text matching.

  // Password field
  if (inputType === 'password')
    return { category: 'auth_password_input', purpose: 'Password input field', confidence: 0.99 };

  // Email field
  if (inputType === 'email')
    return { category: 'auth_email_input', purpose: 'Email address input field', confidence: 0.99 };

  // Phone field
  if (inputType === 'tel')
    return { category: 'input_phone', purpose: 'Phone number field', confidence: 0.99 };

  // Number / date / range
  if (inputType === 'number')
    return { category: 'form_input', purpose: `Numeric input${ph ? ': "' + ph + '"' : ''}`, confidence: 0.95 };
  if (inputType === 'date' || inputType === 'datetime-local' || inputType === 'month')
    return { category: 'form_input', purpose: `Date picker${ph ? ': "' + ph + '"' : ''}`, confidence: 0.95 };

  // Search type input — text field
  if (inputType === 'search')
    return { category: 'search_input', purpose: `Search input — type your query here${ph ? ' ("' + ph + '")' : ''}`, confidence: 0.99 };

  // File upload
  if (inputType === 'file')
    return { category: 'file_upload', purpose: 'File upload — click to browse and select a file', confidence: 0.99 };

  // Checkbox / radio / range / color
  if (inputType === 'checkbox')
    return { category: 'checkbox', purpose: `Checkbox: "${aria || tL || name}" — toggle selection`, confidence: 0.97 };
  if (inputType === 'radio')
    return { category: 'radio', purpose: `Radio option: "${aria || tL || name}"`, confidence: 0.97 };

  // Submit / reset buttons — MUST come before search_input (submit buttons share "search" text)
  if (inputType === 'submit' || inputType === 'button' || inputType === 'reset') {
    if (combined.includes('search') || combined.includes('find'))
      return { category: 'search_submit', purpose: `Search submit button — click to run the search`, confidence: 0.98 };
    if (inputType === 'reset')
      return { category: 'button', purpose: `Reset/clear the form`, confidence: 0.93 };
    return { category: 'submit', purpose: `Submit button: "${t || value || aria}"`, confidence: 0.93 };
  }

  // Hidden — skip
  if (inputType === 'hidden') return null;

  // ── name= attribute signals (very strong for form fields) ─────────────────
  if (name === 'q' || name === 'query' || name === 'search' || name === 'keyword')
    return { category: 'search_input', purpose: `Main search text field — type your query here`, confidence: 0.99 };
  if (name === 'username' || name === 'user' || name === 'login')
    return { category: 'auth_email_input', purpose: `Username / login field`, confidence: 0.97 };
  if (name === 'password' || name === 'pass' || name === 'pwd')
    return { category: 'auth_password_input', purpose: 'Password field', confidence: 0.99 };
  if (name === 'email')
    return { category: 'auth_email_input', purpose: 'Email address field', confidence: 0.98 };

  // ── href-based routing for links ──────────────────────────────────────────
  // Only for real <a> tags with non-trivial hrefs
  if (tag === 'a' && href) {
    // Anchor / same-page scroll — low value
    if (hrefRaw.startsWith('#'))
      return { category: 'anchor', purpose: `In-page anchor: "${t}"`, confidence: 0.90 };
    // JavaScript void — acts like a button
    if (hrefRaw.startsWith('javascript:'))
      return null; // let later rules classify by text
    // Pattern-based nav link classification from URL path
    const path = hrefRaw.split('?')[0].replace(/\/$/, '');
    if (/\/(jobs?|careers?|work-at)/i.test(path))
      return { category: 'nav_jobs', purpose: `Link to Jobs section: "${t}"`, confidence: 0.94 };
    if (/\/(messages?|messaging|inbox|chat)/i.test(path))
      return { category: 'nav_messages', purpose: `Link to Messages: "${t}"`, confidence: 0.93 };
    if (/\/(notifications?|alerts?)/i.test(path))
      return { category: 'nav_notifications', purpose: `Link to Notifications: "${t}"`, confidence: 0.93 };
    if (/\/(profile|me|account|user)/i.test(path))
      return { category: 'nav_profile', purpose: `Link to Profile/Account: "${t}"`, confidence: 0.92 };
    if (/\/(network|connections?|contacts?)/i.test(path))
      return { category: 'nav_network', purpose: `Link to Network/Connections: "${t}"`, confidence: 0.92 };
    if (/\/(settings?|preferences?|config)/i.test(path))
      return { category: 'settings', purpose: `Link to Settings: "${t}"`, confidence: 0.93 };
    if (/\/(login|signin|sign-in|auth)/i.test(path))
      return { category: 'auth_login', purpose: `Link to login page`, confidence: 0.96 };
    if (/\/(signup|register|join|create-account)/i.test(path))
      return { category: 'auth_signup', purpose: `Link to sign-up page`, confidence: 0.96 };
    if (/\/(search|find|results?)/i.test(path))
      return { category: 'search_link', purpose: `Link to search: "${t}"`, confidence: 0.88 };
    if (/\/(watch|video|play)/i.test(path))
      return { category: 'media_link', purpose: `Link to video/media: "${t}"`, confidence: 0.88 };
    if (/\/(product|item|dp|p)\//i.test(path))
      return { category: 'product_link', purpose: `Product link: "${t}"`, confidence: 0.88 };
    if (/\/(article|post|blog|news)\//i.test(path))
      return { category: 'content_link', purpose: `Article/post link: "${t}"`, confidence: 0.85 };
  }

  // ── Auth (text-based) ─────────────────────────────────────────────────────
  if (['sign in','log in','login','signin'].some(k => tL === k || aria === k))
    return { category: 'auth_login',  purpose: 'Opens login form to sign in', confidence: 0.99 };
  if (['sign up','create account','join now','register','get started','create free account'].some(k => tL === k))
    return { category: 'auth_signup', purpose: 'Opens sign-up / account creation form', confidence: 0.99 };
  if (['sign out','log out','logout','signout'].some(k => tL === k))
    return { category: 'auth_logout', purpose: 'Signs the user out', confidence: 0.99 };
  if (ph.includes('password') || ph.includes('passcode'))
    return { category: 'auth_password_input', purpose: 'Password input field', confidence: 0.98 };
  if (ph.includes('email address') || ph.includes('your email'))
    return { category: 'auth_email_input', purpose: 'Email address input field', confidence: 0.98 };

  // ── Voice / microphone ────────────────────────────────────────────────────
  if (combined.includes('voice') || combined.includes('microphone') || combined.includes('speak') || aria.includes('voice'))
    return { category: 'voice_input', purpose: 'Voice search — tap to speak your query', confidence: 0.97 };

  // ── Auth ───────────────────────────────────────────────────────────────────
  // ── Cookie / privacy banners ───────────────────────────────────────────────
  if (['accept all','accept cookies','allow all','i agree','got it','accept & continue'].some(k => tL === k))
    return { category: 'cookie_accept', purpose: 'Accepts cookies/privacy banner — must click to proceed', confidence: 0.99 };
  if (['reject all','decline','necessary only','manage cookies'].some(k => tL === k))
    return { category: 'cookie_reject', purpose: 'Rejects optional cookies', confidence: 0.95 };

  // ── Close / dismiss / overlays ─────────────────────────────────────────────
  if (['×','✕','✖','close','dismiss','not now','maybe later','no thanks','skip for now','remind me later','cancel'].some(k => tL === k) || aria === 'close' || id.includes('modal-close') || id.includes('close-btn'))
    return { category: 'dismiss', purpose: 'Closes popup, modal, or banner', confidence: 0.97 };

  // ── role=button elements that mention "search" = submit buttons, NOT inputs ─
  // Catches <input type="submit" role="button" aria-label="Google Search"> etc.
  if ((role === 'button' || role === 'searchbutton') &&
      (combined.includes('search') || combined.includes('find') || aria.includes('search')))
    return { category: 'search_submit', purpose: 'Search submit button — click to run the search', confidence: 0.98 };

  // ── Search inputs (text fields without inputType already handled above) ────
  if ((tag === 'input' || tag === 'textarea') &&
      role !== 'button' && role !== 'searchbutton' &&       // ← never misclassify buttons
      inputType !== 'submit' && inputType !== 'button' && inputType !== 'reset' &&
      (ph.includes('search') || ph.includes('find') || id.includes('search') || aria.includes('search')))
    return { category: 'search_input', purpose: `Search input — type your query here${ph ? ' ("' + ph + '")' : ''}`, confidence: 0.98 };

  // ── Search submit buttons (buttons with "search" in label, not handled by inputType) ─
  if ((tag === 'button' || tag === 'input') && (tL.includes('search') || tL.includes('find now') || aria.includes('search button')))
    return { category: 'search_submit', purpose: 'Search submit button — click to run the search', confidence: 0.96 };

  // ── Apply / job CTAs ───────────────────────────────────────────────────────
  if (['easy apply','apply now','apply','1-click apply','quick apply','apply here'].some(k => tL === k))
    return { category: 'apply_button', purpose: 'Starts the job application flow', confidence: 0.99 };
  if (['save job','save','unsave','bookmark'].some(k => tL === k) && (id.includes('job') || cls.includes('job') || cls.includes('save')))
    return { category: 'save_item', purpose: 'Saves this job/item for later', confidence: 0.93 };

  // ── Social / engagement ────────────────────────────────────────────────────
  if (['like','👍','love','react'].some(k => tL === k || tL.startsWith('like ')))
    return { category: 'like',       purpose: 'Like or react to this post', confidence: 0.95 };
  if (['subscribe','subscribed','unsubscribe'].some(k => tL === k))
    return { category: 'subscribe',  purpose: tL === 'subscribed' ? 'Already subscribed — click to unsubscribe' : 'Subscribe to this channel/account', confidence: 0.97 };
  if (['follow','following','unfollow'].some(k => tL === k))
    return { category: 'follow',     purpose: tL === 'following' ? 'Currently following — click to unfollow' : 'Follow this person or page', confidence: 0.96 };
  if (['connect','connected','pending'].some(k => tL === k) && (id.includes('connect') || cls.includes('connect')))
    return { category: 'connect',    purpose: tL === 'connected' ? 'Already connected' : 'Send a connection request', confidence: 0.95 };
  if (['comment','add a comment','write a comment','reply'].some(k => tL === k || ph.includes(k)))
    return { category: 'comment',    purpose: 'Write a comment or reply', confidence: 0.94 };
  if (['share','repost','retweet','reshare'].some(k => tL === k))
    return { category: 'share',      purpose: 'Share or repost this content', confidence: 0.95 };
  if (['message','send message','send a message','chat','dm'].some(k => tL === k))
    return { category: 'message',    purpose: 'Open a direct message conversation', confidence: 0.95 };

  // ── Form submit / confirm ──────────────────────────────────────────────────
  if (['submit','submit application','submit form','send','send message','post','publish','save changes','update','confirm','done','finish','complete','continue','next','next step','proceed'].some(k => tL === k))
    return { category: 'submit',     purpose: `Submits or confirms: "${t}"`, confidence: 0.97 };

  // ── Navigation links ───────────────────────────────────────────────────────
  if (['home','feed','for you','following'].some(k => tL === k))
    return { category: 'nav_home',   purpose: 'Navigates to home/main feed', confidence: 0.95 };
  if (['jobs','job search','find jobs'].some(k => tL === k))
    return { category: 'nav_jobs',   purpose: 'Navigates to job search section', confidence: 0.95 };
  if (['messages','inbox','mail','email'].some(k => tL === k) && (tag === 'a' || tag === 'button'))
    return { category: 'nav_messages', purpose: 'Navigates to messages/inbox', confidence: 0.93 };
  if (['notifications','alerts'].some(k => tL === k) && tag !== 'input')
    return { category: 'nav_notifications', purpose: 'Opens notifications panel', confidence: 0.93 };
  if (['profile','my profile','account','me'].some(k => tL === k))
    return { category: 'nav_profile', purpose: 'Opens your profile or account page', confidence: 0.93 };
  if (['network','connections','my network'].some(k => tL === k))
    return { category: 'nav_network', purpose: 'Navigates to network/connections page', confidence: 0.93 };
  if (['explore','discover','browse','trending'].some(k => tL === k))
    return { category: 'nav_explore', purpose: 'Explore or discover new content', confidence: 0.90 };

  // ── Settings / config ──────────────────────────────────────────────────────
  if (['settings','preferences','account settings','configuration'].some(k => tL === k))
    return { category: 'settings',   purpose: 'Opens settings or preferences panel', confidence: 0.95 };
  if (['privacy settings','privacy','privacy & safety'].some(k => tL === k))
    return { category: 'privacy',    purpose: 'Opens privacy settings', confidence: 0.94 };
  if (['help','help center','support','faq'].some(k => tL === k))
    return { category: 'help',       purpose: 'Opens help center or support', confidence: 0.92 };

  // ── Filters / sort ─────────────────────────────────────────────────────────
  if (['filter','filters','all filters','advanced search','advanced filters'].some(k => tL === k))
    return { category: 'filter_open', purpose: 'Opens filter panel to narrow results', confidence: 0.95 };
  if (['sort by','sort','date posted','most recent','most relevant','top'].some(k => tL === k || ph.includes(k)))
    return { category: 'filter_sort', purpose: `Sorting control: "${t || ph}"`, confidence: 0.92 };
  if (['remote','on-site','hybrid','full-time','part-time','contract','internship','entry level','mid-senior','director'].some(k => tL === k))
    return { category: 'filter_chip', purpose: `Filter: "${t}" — toggles this search filter`, confidence: 0.93 };
  if (['experience level','job type','date posted','salary','company','location'].some(k => tL === k || ph.includes(k)))
    return { category: 'filter_dropdown', purpose: `Filter dropdown: "${t || ph}"`, confidence: 0.91 };

  // ── Form inputs ────────────────────────────────────────────────────────────
  if (tag === 'input' || tag === 'textarea') {
    if (ph.includes('first name') || ph.includes('last name') || ph.includes('full name') || ph.includes('your name'))
      return { category: 'input_name',    purpose: `Name field: "${ph}"`, confidence: 0.96 };
    if (ph.includes('phone') || ph.includes('mobile') || inputType === 'tel')
      return { category: 'input_phone',   purpose: `Phone number field: "${ph}"`, confidence: 0.96 };
    if (ph.includes('address') || ph.includes('city') || ph.includes('zip') || ph.includes('postcode'))
      return { category: 'input_address', purpose: `Address/location field: "${ph}"`, confidence: 0.95 };
    if (ph.includes('resume') || ph.includes('cv') || ph.includes('upload'))
      return { category: 'input_resume',  purpose: `Upload field: "${ph}"`, confidence: 0.96 };
    if (ph.includes('cover letter') || ph.includes('additional info') || ph.includes('tell us'))
      return { category: 'input_freetext', purpose: `Free-text field: "${ph}"`, confidence: 0.94 };
    if (ph.includes('message') || ph.includes('write') || ph.includes('type'))
      return { category: 'input_message', purpose: `Message/compose field: "${ph}"`, confidence: 0.94 };
    if (ph.includes('location') || ph.includes('city, state') || ph.includes('where'))
      return { category: 'input_location', purpose: `Location input: "${ph}"`, confidence: 0.95 };
    if (ph.includes('keyword') || ph.includes('job title') || ph.includes('skills') || ph.includes('what'))
      return { category: 'input_keyword', purpose: `Keyword/job-title input: "${ph}"`, confidence: 0.94 };
    if (ph.includes('company') || ph.includes('organization'))
      return { category: 'input_company', purpose: `Company name input: "${ph}"`, confidence: 0.93 };
    if (ph || t)
      return { category: 'form_input',    purpose: `Form field: "${ph || t}"`, confidence: 0.82 };
  }

  // ── File / upload ──────────────────────────────────────────────────────────
  if (inputType === 'file' || tL.includes('upload') || tL.includes('attach file') || tL.includes('choose file'))
    return { category: 'file_upload', purpose: 'Upload a file (resume, image, document)', confidence: 0.95 };

  // ── Video / media controls ─────────────────────────────────────────────────
  if (['play','pause','play video','watch now'].some(k => tL === k) || aria.includes('play'))
    return { category: 'media_play',   purpose: 'Plays or pauses the video', confidence: 0.95 };
  if (tL === 'mute' || tL === 'unmute' || aria.includes('mute'))
    return { category: 'media_mute',   purpose: 'Mutes or unmutes audio', confidence: 0.94 };
  if (['fullscreen','full screen','expand'].some(k => tL === k || aria.includes(k)))
    return { category: 'media_fullscreen', purpose: 'Toggles fullscreen mode', confidence: 0.93 };
  if (['cc','captions','subtitles','closed captions'].some(k => tL === k))
    return { category: 'media_captions', purpose: 'Toggles captions/subtitles', confidence: 0.93 };
  if (tL.includes('skip ad') || tL.includes('skip intro'))
    return { category: 'skip_ad',      purpose: `Skips ad or intro — click to skip`, confidence: 0.99 };
  if (['next','next video','autoplay'].some(k => tL === k) && (id.includes('player') || cls.includes('player') || cls.includes('video')))
    return { category: 'media_next',   purpose: 'Plays the next video', confidence: 0.90 };

  // ── E-commerce ─────────────────────────────────────────────────────────────
  if (['add to cart','add to bag','add to basket'].some(k => tL === k))
    return { category: 'ecom_add_cart', purpose: 'Adds this item to your shopping cart', confidence: 0.99 };
  if (['buy now','buy','purchase','order now','checkout'].some(k => tL === k))
    return { category: 'ecom_buy',      purpose: 'Proceeds to purchase/checkout', confidence: 0.98 };
  if (tL.includes('add to wishlist') || tL.includes('save for later'))
    return { category: 'ecom_wishlist', purpose: 'Saves item to wishlist/saved items', confidence: 0.95 };
  if (['place order','confirm order','pay now','complete order'].some(k => tL === k))
    return { category: 'ecom_confirm',  purpose: 'Finalises and places the order', confidence: 0.98 };

  // ── Content creation ───────────────────────────────────────────────────────
  if (['create post','new post','start a post','write a post','compose','what\'s on your mind'].some(k => tL === k || ph.includes(k)))
    return { category: 'create_post',   purpose: 'Opens post creation composer', confidence: 0.96 };
  if (['create','new','add new','+ new','+','add'].some(k => tL === k))
    return { category: 'create_item',   purpose: `Creates a new item: "${t}"`, confidence: 0.85 };
  if (['upload','upload video','upload photo','upload file'].some(k => tL === k))
    return { category: 'upload',        purpose: `Upload content: "${t}"`, confidence: 0.95 };

  // ── Pagination / load more ─────────────────────────────────────────────────
  if (['load more','show more','see more','view more','more results'].some(k => tL === k || tL.includes(k)))
    return { category: 'load_more',     purpose: 'Loads more items/results below', confidence: 0.95 };
  if (['next page','previous page','prev'].some(k => tL === k) || aria.includes('next page'))
    return { category: 'pagination',    purpose: `Pagination: "${t}"`, confidence: 0.93 };

  // ── Dropdown / menu toggles ────────────────────────────────────────────────
  if (tL === '...' || tL === '…' || tL === 'more' || aria === 'more options' || aria === 'more actions' || aria.includes('overflow') || id.includes('kebab') || id.includes('dropdown-toggle'))
    return { category: 'more_options',  purpose: 'Opens overflow/more-options menu', confidence: 0.92 };
  if (tL === 'menu' || aria === 'open menu' || aria === 'main menu' || id.includes('hamburger') || id.includes('nav-toggle'))
    return { category: 'menu_toggle',   purpose: 'Opens navigation/hamburger menu', confidence: 0.92 };

  // ── Tabs / section switchers ───────────────────────────────────────────────
  if (['posts','activity','experience','education','skills','about','reviews','photos','videos','community','discussions'].some(k => tL === k) && (tag === 'button' || tag === 'a'))
    return { category: 'tab',           purpose: `Switches to "${t}" section/tab`, confidence: 0.88 };

  // ── Back / breadcrumb ──────────────────────────────────────────────────────
  if (['back','go back','← back','‹ back'].some(k => tL === k || tL.startsWith('back to')))
    return { category: 'back_nav',      purpose: `Go back: "${t}"`, confidence: 0.92 };

  // ── Generic buttons — at least name what the button says ─────────────────
  if ((tag === 'button' || tag === 'a') && t.length > 1 && t.length < 80) {
    // Detect if it looks like a navigation link
    if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
      return { category: 'link',        purpose: `Link to "${t}" (${href.length > 40 ? href.substring(0, 40) + '…' : href})`, confidence: 0.72 };
    }
    return { category: 'button',        purpose: `Button: "${t}" — click to activate`, confidence: 0.70 };
  }

  // ── Select / combobox ──────────────────────────────────────────────────────
  if (tag === 'select' || tag === 'combobox') {
    return { category: 'select',        purpose: `Dropdown selector: "${t || ph || 'select an option'}"`, confidence: 0.88 };
  }

  // ── Checkbox / radio ───────────────────────────────────────────────────────
  if (inputType === 'checkbox')
    return { category: 'checkbox',      purpose: `Checkbox: "${t || aria}" — toggles selection`, confidence: 0.87 };
  if (inputType === 'radio')
    return { category: 'radio',         purpose: `Radio option: "${t || aria}"`, confidence: 0.87 };

  return null;
}

// ── Detect page purpose from URL + visible elements ───────────────────────────
function classifyPagePurpose(url, title, elements) {
  const u = url.toLowerCase();
  const t = (title || '').toLowerCase();
  const texts = elements.map(e => (e.text || '').toLowerCase()).join(' ');
  const ph    = elements.map(e => (e.placeholder || '').toLowerCase()).join(' ');
  const allText = texts + ' ' + ph;

  // Specific page patterns — most specific first
  if (u.includes('/apply') || allText.includes('submit application') || allText.includes('application submitted'))
    return 'application_form';
  if (u.includes('/checkout') || allText.includes('order total') || allText.includes('place order'))
    return 'checkout';
  if (u.includes('/cart') || allText.includes('shopping cart') || allText.includes('your basket'))
    return 'shopping_cart';
  if (u.includes('/jobs') || u.includes('/job/') || allText.includes('easy apply') || allText.includes('job description'))
    return 'job_listing';
  if (u.includes('/jobs/search') || u.includes('/jobs?') || (u.includes('indeed') && u.includes('q=')) || (u.includes('linkedin') && u.includes('jobs')))
    return 'job_search_results';
  if (u.includes('/messaging') || u.includes('/messages') || u.includes('/inbox') || allText.includes('type a message') || allText.includes('compose'))
    return 'messaging';
  if ((u.includes('/search') || u.includes('?q=') || u.includes('?search=') || allText.includes('results for')) && !u.includes('jobs'))
    return 'search_results';
  if (u.includes('/feed') || u.includes('/home') || allText.includes('share a post') || allText.includes('start a post') || allText.includes("what's on your mind"))
    return 'social_feed';
  if (u.includes('/watch') || u.includes('/video/') || allText.includes('subscribe') && allText.includes('views'))
    return 'video_player';
  if (u.includes('youtube.com') && !u.includes('/watch'))
    return 'video_feed';
  if (u.includes('/login') || u.includes('/signin') || u.includes('/signup') || u.includes('/register') || allText.includes('sign in to') || allText.includes('create account'))
    return 'auth_page';
  if (u.includes('/profile') || u.includes('/in/') || allText.includes('connect') && allText.includes('message') && allText.includes('follow'))
    return 'user_profile';
  if (u.includes('/company/') || (allText.includes('about') && allText.includes('employees') && allText.includes('follow')))
    return 'company_page';
  if (u.includes('/product/') || u.includes('/dp/') || allText.includes('add to cart') || allText.includes('buy now'))
    return 'product_listing';
  if (u.includes('/settings') || u.includes('/preferences') || u.includes('/account'))
    return 'settings';
  if (u.includes('/notifications'))
    return 'notifications';

  // Domain-level fallbacks
  if (u.includes('google.com')) return 'google_homepage_or_search';
  if (u.includes('youtube.com')) return 'youtube';
  if (u.includes('linkedin.com')) return 'linkedin_general';
  if (u.includes('github.com')) return 'github';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter_feed';
  if (u.includes('gmail.com') || u.includes('mail.google.com')) return 'gmail';
  if (u.includes('amazon.')) return 'amazon_general';

  return 'general';
}

// ── Detect what flows exist on a page ─────────────────────────────────────────
function detectFlows(elements) {
  const flows = {};
  const cats  = new Set(elements.map(e => e._exploration?.category).filter(Boolean));

  if (cats.has('apply_button'))
    flows.apply_job = ['click apply_button', 'fill form_inputs', 'click submit'];
  if (cats.has('search_input'))
    flows.search = ['type in search_input', 'press Enter or click search_submit', 'read results'];
  if (cats.has('auth_login'))
    flows.login = ['click auth_login button', 'fill auth_email_input + auth_password_input', 'click submit'];
  if (cats.has('filter_open') || cats.has('filter_chip') || cats.has('filter_sort'))
    flows.filter_results = ['click filter control', 'select option', 'observe updated results'];
  if (cats.has('dismiss') || cats.has('cookie_accept'))
    flows.dismiss_popup = ['click dismiss or cookie_accept button first before any other action'];
  if (cats.has('ecom_add_cart'))
    flows.purchase = ['click ecom_add_cart', 'go to cart', 'checkout', 'ecom_confirm'];
  if (cats.has('create_post'))
    flows.post_content = ['click create_post', 'type in input_message', 'click submit'];
  if (cats.has('message'))
    flows.send_message = ['click message button', 'type in input_message', 'click submit'];

  return flows;
}

// -- Build a compact, LLM-readable page summary --------------------------------
// Ordered by visual layer: overlays on top first, then page content.
// Links annotated with domain so the agent knows what stays on-site vs leaves.
function buildPageSummary(enrichedElements, pageKnowledge) {
  if (!enrichedElements) return '';

  var lines   = [];
  var printed = {};

  // Current domain for link-origin detection
  var currentDomain = '';
  try { currentDomain = new URL(pageKnowledge && pageKnowledge.url || '').hostname.replace(/^www\\./, ''); } catch (_) {}

  function fmt(el, indent) {
    indent = indent || '  ';
    var cat     = (el._exploration && el._exploration.category) || el.tag || '?';
    var purpose = (el._exploration && el._exploration.purpose)  || '';
    var rawText = (el.text        || '').trim();
    var ph      = (el.placeholder || '').trim();
    var label   = rawText ? ('"'  + rawText.substring(0, 45) + '"'): (ph ? ('[' + ph.substring(0, 35) + ']') : '');

    // Domain-aware link annotation -- stops agent clicking in-page links to reach other sites
    if (el.tag === 'a' || (el.id && el.id.indexOf('LNK') === 0)) {
      try {
        var href = el.href || el.hrefRaw || '';
        if (!href || href === '#' || (href.charAt && href.charAt(0) === '#')) {
          purpose += '  [in-page anchor, stays here]';
        } else if (href.indexOf('javascript:') === 0) {
          purpose += '  [JS action, no page change]';
        } else {
          var fullHref = href.indexOf('http') === 0 ? href : ('https://' + currentDomain + (href.charAt(0) === '/' ? '' : '/') + href);
          var linkDomain = new URL(fullHref).hostname.replace(/^www\\./, '');
          if (!linkDomain || linkDomain === currentDomain) {
            purpose += '  [stays on ' + currentDomain + '  does NOT go to another site]';
          } else {
            purpose += '  [goes to ' + linkDomain + ']';
          }
        }
      } catch (_) {
        if (el.hrefRaw) purpose += '  [relative: ' + el.hrefRaw.substring(0, 30) + ']';
      }
    }
    return indent + el.id + '  (' + cat + ')  ' + label + '  ->  ' + purpose;
  }

  // 1. Page type and domain
  if (pageKnowledge && pageKnowledge.purpose) lines.push('PAGE TYPE: ' + pageKnowledge.purpose);
  if (currentDomain) lines.push('SITE: ' + currentDomain);

  // 2. [!] OVERLAY LAYER -- visually ON TOP. Agent MUST handle these FIRST.
  var overlayEls = enrichedElements
    .filter(function(e) { return e.isOverlay || e.layer === 'overlay'; })
    .sort(function(a, b) { return (b.zIndex || 0) - (a.zIndex || 0); });

  var blockerCatList = ['dismiss', 'cookie_accept', 'cookie_reject'];
  var extraBlockers  = enrichedElements.filter(function(e) {
    var cat = e._exploration && e._exploration.category;
    return blockerCatList.indexOf(cat) !== -1 && !overlayEls.find(function(o) { return o.id === e.id; });
  });
  var allOverlay = overlayEls.concat(extraBlockers);

  if (allOverlay.length > 0) {
    lines.push('');
    lines.push('[!] OVERLAY / POPUP -- ON TOP, handle BEFORE anything below:');
    for (var i = 0; i < Math.min(allOverlay.length, 6); i++) {
      lines.push(fmt(allOverlay[i]));
      printed[allOverlay[i].id] = true;
    }
  }

  if (pageKnowledge && pageKnowledge.blockers && pageKnowledge.blockers.has_login_wall) {
    lines.push('[!] LOGIN WALL -- page requires authentication before any action.');
  }

  if (pageKnowledge && pageKnowledge.flows && Object.keys(pageKnowledge.flows).length > 0) {
    lines.push('FLOWS: ' + Object.keys(pageKnowledge.flows).join(', '));
  }

  // 3. Page-level elements ordered by importance
  var PRIORITY_CATS = [
    'search_input', 'search_submit',
    'auth_email_input', 'auth_password_input', 'auth_login', 'auth_signup',
    'apply_button', 'submit',
    'filter_open', 'filter_chip', 'filter_sort', 'filter_dropdown',
    'ecom_add_cart', 'ecom_buy', 'ecom_confirm',
    'follow', 'connect', 'like', 'message', 'subscribe',
    'create_post', 'upload',
    'nav_jobs', 'nav_home', 'nav_messages', 'nav_profile', 'nav_network', 'nav_explore',
    'load_more', 'pagination',
    'tab', 'more_options', 'menu_toggle',
    'link', 'button',
  ];

  var byCategory = {};
  for (var j = 0; j < enrichedElements.length; j++) {
    var el = enrichedElements[j];
    if (printed[el.id]) continue;
    var cat = el._exploration && el._exploration.category;
    if (!cat) continue;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(el);
  }

  lines.push('');
  lines.push('PAGE ELEMENTS (main layer):');

  var totalPrinted = Object.keys(printed).length;
  for (var c = 0; c < PRIORITY_CATS.length && totalPrinted < 25; c++) {
    var catEls = byCategory[PRIORITY_CATS[c]];
    if (!catEls) continue;
    for (var k = 0; k < Math.min(catEls.length, 3) && totalPrinted < 25; k++) {
      if (printed[catEls[k].id]) continue;
      lines.push(fmt(catEls[k]));
      printed[catEls[k].id] = true;
      totalPrinted++;
    }
  }

  for (var r = 0; r < enrichedElements.length && totalPrinted < 32; r++) {
    var re = enrichedElements[r];
    if (printed[re.id] || !(re._exploration && re._exploration.category)) continue;
    lines.push(fmt(re));
    printed[re.id] = true;
    totalPrinted++;
  }

  var unclassified = enrichedElements
    .filter(function(e) { return !printed[e.id] && (e.text || e.placeholder) && e.id; })
    .slice(0, 4);
  if (unclassified.length) {
    lines.push('OTHER:');
    for (var u = 0; u < unclassified.length; u++) {
      var ue  = unclassified[u];
      var lbl = ue.text ? ('"'  + ue.text.substring(0, 40) + '"'): ('[' + (ue.placeholder || '').substring(0, 30) + ']');
      lines.push('  ' + ue.id + '  (' + ue.tag + ')  ' + lbl);
    }
  }

  return lines.join('\n');
}

// ── Main exploration function ─────────────────────────────────────────────────
async function explorePage({ graph, domain }) {
  if (!graph || !graph.elements) return null;

  const url   = graph.url   || '';
  const title = graph.title || '';

  // 1. Classify every interactive element
  const enrichedElements = (graph.elements || []).map(el => {
    const purpose = classifyElementPurpose(el);
    if (purpose) return { ...el, _exploration: purpose };
    return el;
  });

  // 2. Classify the page itself
  const pagePurpose = classifyPagePurpose(url, title, enrichedElements);

  // 3. Detect known flows
  const flows = detectFlows(enrichedElements);

  // 4. Extract structured element groups
  const byCategory = (cat) => enrichedElements.filter(e => e._exploration?.category === cat);

  const searchInputs = byCategory('search_input');
  const applyButtons = byCategory('apply_button');
  const formInputs   = enrichedElements.filter(e => e._exploration?.category?.startsWith('input_') || e._exploration?.category === 'form_input');
  const dismissBtns  = [...byCategory('dismiss'), ...byCategory('cookie_accept')];
  const filterCtrls  = enrichedElements.filter(e => e._exploration?.category?.startsWith('filter_'));
  const authBtns     = [...byCategory('auth_login'), ...byCategory('auth_signup')];
  const submitBtns   = byCategory('submit');

  // 5. Build the page knowledge record
  const pageKnowledge = {
    url,
    title,
    purpose: pagePurpose,
    mapped_at: new Date().toISOString(),
    element_counts: {
      total:         enrichedElements.length,
      classified:    enrichedElements.filter(e => e._exploration).length,
      search_inputs: searchInputs.length,
      apply_buttons: applyButtons.length,
      form_inputs:   formInputs.length,
      dismiss_btns:  dismissBtns.length,
      filter_ctrls:  filterCtrls.length,
      auth_buttons:  authBtns.length,
    },
    key_elements: {
      search_inputs:   searchInputs.map(e => ({ id: e.id, text: e.text, placeholder: e.placeholder })),
      apply_buttons:   applyButtons.map(e => ({ id: e.id, text: e.text })),
      dismiss_buttons: dismissBtns.map(e => ({ id: e.id, text: e.text })),
      form_inputs:     formInputs.map(e  => ({ id: e.id, placeholder: e.placeholder, text: e.text, category: e._exploration?.category })),
      submit_buttons:  submitBtns.map(e  => ({ id: e.id, text: e.text })),
      auth_buttons:    authBtns.map(e    => ({ id: e.id, text: e.text })),
      filters:         filterCtrls.map(e => ({ id: e.id, text: e.text })),
    },
    flows,
    blockers: {
      has_login_wall:    authBtns.length > 0 && (url.includes('login') || url.includes('signin')),
      has_cookie_banner: dismissBtns.some(e => /(accept|cookie|privacy|agree)/i.test(e.text || '')),
      has_popup:         dismissBtns.length > 0,
    },
  };

  // 6. Build compact LLM-readable summary (injected into contextualStep)
  pageKnowledge.llm_summary = buildPageSummary(enrichedElements, pageKnowledge);

  return {
    pageKnowledge,
    enrichedElements,
    domain: domain || (url.startsWith('http') ? new URL(url).hostname : url.split('/')[0]),
  };
}

// ── Behavioral Learning ───────────────────────────────────────────────────────
function buildBehaviorRecord({ domain, url, elementId, elementText, elementCategory, action, resultUrl, resultPagePurpose, resultElementsAppeared }) {
  return {
    domain,
    url_pattern: url.replace(/\/\d+\/?/g, '/:id/').replace(/[?#].*$/, ''),
    element: { id: elementId, text: elementText, category: elementCategory },
    action,
    result: {
      url_changed:    resultUrl !== url,
      result_url:     resultUrl,
      result_purpose: resultPagePurpose,
      appeared:       (resultElementsAppeared || []).slice(0, 8).map(e => ({ id: e.id, text: e.text, category: e._exploration?.category })),
    },
    recorded_at: new Date().toISOString(),
  };
}

module.exports = { explorePage, classifyElementPurpose, classifyPagePurpose, detectFlows, buildPageSummary, buildBehaviorRecord };
