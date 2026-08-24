"use client";

import Link from "next/link";
import { H1, H2, Lede, P, UL, LI, Note, Table, Th, Td } from "../DocPage";
import InPageToc from "../InPageToc";

export const TOC = [
  { id: "the-short-version", title: "The short version" },
  { id: "your-account", title: "Your account" },
  { id: "projects-and-assets", title: "Projects, assets, and ratings" },
  { id: "api-keys", title: "Bring-your-own API keys" },
  { id: "ai-features", title: "AI features" },
  { id: "services", title: "Services Toolbox relies on" },
  { id: "cookies", title: "Cookies" },
  { id: "desktop-app", title: "The desktop app" },
  { id: "deleting-your-data", title: "Deleting your data" },
  { id: "changes-and-contact", title: "Changes & contact" },
];

export default function PrivacyPolicyPage() {
  return (
    <>
      <H1>Privacy policy</H1>
      <Lede>
        What Toolbox stores about you, where it lives, and when
        anything leaves your machine. Last updated August 13, 2026.
      </Lede>

      <InPageToc items={TOC} />

      <H2 id="the-short-version">The short version</H2>
      <UL>
        <LI>
          Toolbox has <strong>no ads, no analytics scripts, and no
          trackers</strong>. We don&rsquo;t sell or share your data
          with anyone for marketing.
        </LI>
        <LI>
          Everything you save — projects, imported assets,
          preferences — is stored so <em>you</em> can load it again.
          Projects are private by default.
        </LI>
        <LI>
          Your images and graphs only leave our infrastructure when
          you use an AI node that calls an outside provider, and the
          sections below spell out exactly which node sends what,
          where.
        </LI>
      </UL>

      <H2 id="your-account">Your account</H2>
      <P>
        You sign in with Google. From your Google profile we receive
        and store your <strong>email address</strong>,{" "}
        <strong>display name</strong>, and <strong>avatar</strong>.
        The email is used only to identify your account — we
        don&rsquo;t send marketing email. The display name is stored
        in a public profiles table so that public projects can show{" "}
        <em>&ldquo;by &lt;display name&gt;&rdquo;</em> next to the
        title; it&rsquo;s the only piece of account data other users
        ever see.
      </P>
      <P>
        You can use Toolbox without an account, but anything that
        saves to the cloud (projects, preferences, AI recipes)
        requires signing in.
      </P>

      <H2 id="projects-and-assets">Projects, assets, and ratings</H2>
      <UL>
        <LI>
          <strong>Projects</strong> are private by default and stay
          that way until you flip them public yourself. Private
          projects are visible only to you; public projects are
          visible to everyone, including signed-out visitors. See{" "}
          <Link href="/docs/projects/public-private">Public vs.
          private</Link> for the ownership rules.
        </LI>
        <LI>
          <strong>Imported assets</strong> (images, audio, and other
          media you bring into a graph) are uploaded to file storage
          so your project can reload them later. Assets follow their
          project&rsquo;s visibility.
        </LI>
        <LI>
          <strong>Thumbnails</strong> of your projects are stored so
          the load screen can show previews.
        </LI>
        <LI>
          <strong>Ratings</strong> you leave on public projects are
          stored with your account — one rating per project, and you
          can change it any time. Other users only ever see the
          aggregate average and count, never who rated what.
        </LI>
      </UL>

      <H2 id="api-keys">Bring-your-own API keys</H2>
      <P>
        Some AI features run on your own provider accounts. If you
        add an <strong>OpenAI key</strong>,{" "}
        <strong>Anthropic key</strong>, or{" "}
        <strong>Hugging Face token</strong> in User Preferences, it
        is stored in your preferences row in the database, protected
        by row-level security so only your own authenticated session
        can read it back.
      </P>
      <UL>
        <LI>
          Keys are used solely to call the matching provider on your
          behalf when you use the feature that needs them.
        </LI>
        <LI>
          For AI recipes, your Anthropic key is read on the server at
          request time — it never travels in a request body to or
          from your browser.
        </LI>
        <LI>
          You can clear any stored key from User Preferences at any
          time.
        </LI>
      </UL>

      <H2 id="ai-features">AI features</H2>
      <P>
        Each AI feature is opt-in — nothing is sent anywhere until
        you use the node or button in question.
      </P>
      <UL>
        <LI>
          <strong>Image Generate node</strong> — your prompt and any
          reference images you wire in are sent to OpenAI using your
          own OpenAI key. Generated images and their prompts are
          saved to a private storage bucket in your account so the
          node&rsquo;s history survives reloads.
        </LI>
        <LI>
          <strong>AI recipes</strong> (generate / edit a graph from a
          prompt) — your prompt and the relevant graph context are
          sent to Anthropic&rsquo;s Claude API, using your key if
          you&rsquo;ve added one. Requires sign-in.
        </LI>
        <LI>
          <strong>Background removal, depth, and segmentation</strong>{" "}
          run entirely on your device, in the browser. The model
          weights are downloaded from Hugging Face the first time you
          use them, but your images never leave your machine for
          these features.
        </LI>
      </UL>

      <H2 id="services">Services Toolbox relies on</H2>
      <Table>
        <thead>
          <tr>
            <Th>Service</Th>
            <Th>What it does</Th>
            <Th>What it receives</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Supabase</Td>
            <Td>Sign-in, database, file storage</Td>
            <Td>
              Account info, projects, assets, preferences (including
              any API keys you add), ratings
            </Td>
          </tr>
          <tr>
            <Td>Vercel</Td>
            <Td>Hosts the web app</Td>
            <Td>
              Standard server request logs, including IP addresses
            </Td>
          </tr>
          <tr>
            <Td>OpenAI</Td>
            <Td>Image Generate node</Td>
            <Td>
              Prompts and reference images, only when you use the
              node, under your own key
            </Td>
          </tr>
          <tr>
            <Td>Anthropic</Td>
            <Td>AI recipe generation and editing</Td>
            <Td>
              Your prompt and graph context, only when you use the
              feature
            </Td>
          </tr>
          <tr>
            <Td>Hugging Face</Td>
            <Td>Serves on-device AI model weights</Td>
            <Td>
              Standard download requests; your optional access token
              if you&rsquo;ve added one
            </Td>
          </tr>
          <tr>
            <Td>GitHub</Td>
            <Td>Desktop app update checks and downloads</Td>
            <Td>Standard request metadata (IP, app version)</Td>
          </tr>
        </tbody>
      </Table>
      <P>
        Each of these providers processes that data under its own
        privacy policy. We don&rsquo;t send them anything beyond what
        the table lists.
      </P>

      <H2 id="cookies">Cookies</H2>
      <P>
        Toolbox sets only the session cookies needed to keep you
        signed in. There are no advertising, analytics, or
        third-party tracking cookies.
      </P>

      <H2 id="desktop-app">The desktop app</H2>
      <P>
        The desktop app is the same application in a native shell,
        talking to the same services, so everything above applies
        equally. The one addition: on launch it checks GitHub
        Releases for updates and downloads them from there.
      </P>

      <H2 id="deleting-your-data">Deleting your data</H2>
      <UL>
        <LI>
          Delete any project you own from the load screen — its
          assets and thumbnail go with it.
        </LI>
        <LI>
          Clear stored API keys from User Preferences at any time.
        </LI>
        <LI>
          To delete your account and everything attached to it,
          email us (address below) and we&rsquo;ll remove it.
        </LI>
      </UL>

      <Note>
        Copies are the one caveat: if someone saved a copy of one of
        your <em>public</em> projects while it was public, that copy
        belongs to them and isn&rsquo;t affected by you deleting the
        original.
      </Note>

      <H2 id="changes-and-contact">Changes & contact</H2>
      <P>
        If this policy changes, we&rsquo;ll update this page and the
        date at the top. Questions, or an account deletion request:{" "}
        <a href="mailto:henry@isthishenry.com">
          henry@isthishenry.com
        </a>
        .
      </P>
    </>
  );
}
