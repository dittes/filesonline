// demo.js
// Generates a small synthetic demo archive covering the parser's edge cases.
// All addresses use example.com / example.org — no real emails.

/** 1x1 red PNG */
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * @returns {string} demo mbox content
 */
export function generateDemoMbox() {
  const messages = [];

  // 1. Plain-text message (unread)
  messages.push(`From alice@example.com Mon Jan  5 09:15:00 2026
From: Alice Martin <alice@example.com>
To: You <you@example.org>
Subject: Welcome to the demo archive
Date: Mon, 5 Jan 2026 09:15:00 +0100
Message-ID: <demo-001@example.com>
Content-Type: text/plain; charset=utf-8

Hi there,

this is a plain-text message from the generated demo archive.
It has no attachments and no HTML part.

URLs are linkified automatically: https://files-online.com

Best,
Alice
--
Alice Martin
Demo Corp.`);

  // 2. HTML message
  messages.push(`From bob@example.com Mon Jan  5 10:30:00 2026
From: Bob Chen <bob@example.com>
To: You <you@example.org>
Subject: An HTML newsletter
Date: Mon, 5 Jan 2026 10:30:00 +0100
Message-ID: <demo-002@example.com>
Status: RO
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

<html><body>
<h1 style="color:#1B4FD8;">HTML rendering demo</h1>
<p>This message is <strong>HTML only</strong>. It is sanitized and rendered
inside a sandboxed iframe.</p>
<p><img src="https://example.com/tracking-pixel.png" width="1" height="1" alt="">
The tracking pixel above is blocked until you click <em>Load remote content</em>.</p>
<table border="1" cellpadding="6"><tr><td>Tables</td><td>work</td></tr></table>
</body></html>`);

  // 3. Multipart/alternative message
  messages.push(`From carol@example.com Tue Jan  6 08:00:00 2026
From: Carol Diaz <carol@example.com>
To: You <you@example.org>
Subject: Multipart alternative message
Date: Tue, 6 Jan 2026 08:00:00 +0100
Message-ID: <demo-003@example.com>
Status: RO
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="demo-alt-boundary"

--demo-alt-boundary
Content-Type: text/plain; charset=utf-8

This is the plain-text alternative of a multipart message.

--demo-alt-boundary
Content-Type: text/html; charset=utf-8

<html><body><p>This is the <b>HTML alternative</b> of a multipart message.
Use the <i>Plain text</i> tab to compare.</p></body></html>

--demo-alt-boundary--`);

  // 4+5+6. Threaded conversation
  messages.push(`From dave@example.com Wed Jan  7 09:00:00 2026
From: Dave Evans <dave@example.com>
To: You <you@example.org>
Cc: Alice Martin <alice@example.com>
Subject: Project kickoff
Date: Wed, 7 Jan 2026 09:00:00 +0100
Message-ID: <demo-thread-1@example.com>
Status: RO
Content-Type: text/plain; charset=utf-8

Team,

shall we kick off the project on Friday? Agenda attached in a follow-up.

Dave`);

  messages.push(`From you@example.org Wed Jan  7 09:45:00 2026
From: You <you@example.org>
To: Dave Evans <dave@example.com>
Subject: Re: Project kickoff
Date: Wed, 7 Jan 2026 09:45:00 +0100
Message-ID: <demo-thread-2@example.org>
In-Reply-To: <demo-thread-1@example.com>
References: <demo-thread-1@example.com>
Status: RO
Content-Type: text/plain; charset=utf-8

Friday works for me.

> shall we kick off the project on Friday? Agenda attached in a follow-up.

The quoted reply above can be collapsed in the viewer.`);

  messages.push(`From alice@example.com Wed Jan  7 11:20:00 2026
From: Alice Martin <alice@example.com>
To: Dave Evans <dave@example.com>, You <you@example.org>
Subject: Re: Project kickoff
Date: Wed, 7 Jan 2026 11:20:00 +0100
Message-ID: <demo-thread-3@example.com>
In-Reply-To: <demo-thread-2@example.org>
References: <demo-thread-1@example.com> <demo-thread-2@example.org>
Content-Type: text/plain; charset=utf-8

Works for me too — switch to thread view to see this conversation grouped.`);

  // 7. Message with attachment (multipart/mixed, base64 PNG)
  messages.push(`From erin@example.com Thu Jan  8 14:10:00 2026
From: Erin Fox <erin@example.com>
To: You <you@example.org>
Subject: Attachment demo (tiny PNG)
Date: Thu, 8 Jan 2026 14:10:00 +0100
Message-ID: <demo-004@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="demo-mixed-boundary"

--demo-mixed-boundary
Content-Type: text/plain; charset=utf-8

The attached pixel.png is a 1x1 image, base64-encoded. Click it in the
attachment list to preview or download it.

--demo-mixed-boundary
Content-Type: image/png; name="pixel.png"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="pixel.png"

${DEMO_PNG_BASE64}
--demo-mixed-boundary--`);

  // 8. Folded headers + RFC 2047 encoded subject
  messages.push(`From frank@example.com Fri Jan  9 16:45:00 2026
From: Frank Gruber
 <frank@example.com>
To: You
 <you@example.org>
Subject: =?utf-8?B?Rm9sZGVkIGhlYWRlcnMgKyDDnG1sw6R1dGUgZGVtbw==?=
Date: Fri, 9 Jan 2026 16:45:00 +0100
Message-ID: <demo-005@example.com>
X-Custom-Header: this header value is folded
 across two lines
Content-Type: text/plain; charset=utf-8

The From, To, Subject and X-Custom-Header headers of this message are folded
across multiple lines, and the subject is RFC 2047 base64-encoded UTF-8.`);

  // 9. Quoted-printable message
  messages.push(`From grace@example.com Sat Jan 10 12:00:00 2026
From: Grace H=?iso-8859-1?Q?=FC?=bner <grace@example.com>
To: You <you@example.org>
Subject: Quoted-printable encoding demo
Date: Sat, 10 Jan 2026 12:00:00 +0100
Message-ID: <demo-006@example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Gr=FC=DFe aus M=FCnchen! This body is quoted-printable encoded ISO-8859-1.
Soft line breaks are joined correctly, like this very long sentence that co=
ntinues on the next physical line.`);

  // 10. Base64 text body
  messages.push(`From henry@example.com Sun Jan 11 09:30:00 2026
From: Henry Ito <henry@example.com>
To: You <you@example.org>
Subject: Base64 body demo
Date: Sun, 11 Jan 2026 09:30:00 +0100
Message-ID: <demo-007@example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

VGhpcyBib2R5IGlzIGJhc2U2NC1lbmNvZGVkLiBJZiB5b3UgY2FuIHJlYWQgdGhpcyBzZW50ZW5j
ZSwgYmFzZTY0IGRlY29kaW5nIHdvcmtzIGNvcnJlY3RseS4g8J+OiQ==`);

  // 11. Body line beginning with "From " (mboxrd-escaped)
  messages.push(`From iris@example.com Mon Jan 12 08:20:00 2026
From: Iris Johnson <iris@example.com>
To: You <you@example.org>
Subject: A body line starting with "From"
Date: Mon, 12 Jan 2026 08:20:00 +0100
Message-ID: <demo-008@example.com>
Content-Type: text/plain; charset=utf-8

The next line begins with the word "From" and is escaped in the mbox file:
>From my point of view, the parser must not split the message here.
If you can read both this line and the one above, escaping works.`);

  return messages.join('\n\n') + '\n';
}

/**
 * Demo archive as a File object, ready for the normal import pipeline.
 * @returns {File}
 */
export function generateDemoFile() {
  return new File([generateDemoMbox()], 'demo-archive.mbox', { type: 'application/mbox' });
}
