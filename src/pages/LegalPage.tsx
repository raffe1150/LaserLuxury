import { useEffect } from 'react';
import '../styles/legal.css';

type LegalDocument = 'privacy' | 'terms';

const LAST_UPDATED = '23 September 2026';

function BrandMark() {
  return (
    <svg aria-hidden="true" width="32" height="32" viewBox="0 0 36 36" fill="none">
      <rect width="36" height="36" rx="10" fill="#3ddc84" />
      <path d="M10 22 18 10l8 12M14 22h8" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18" cy="26" r="2.5" fill="#060a07" />
    </svg>
  );
}

function PrivacyPolicy() {
  return <>
    <section>
      <h2>1. About OdinLink and this policy</h2>
      <p>OdinLink is a software service for businesses that helps manage customer conversations, respond through connected messaging channels, and support appointment booking and related workflows. This Privacy Policy explains how personal data is handled when a business uses OdinLink, when someone communicates with a business through a channel connected to OdinLink, or when a person uses an OdinLink account.</p>
      <p>For customer conversations and booking data, the business using OdinLink generally decides why and how the data is used. OdinLink processes that data to provide the service on the business's instructions. For account administration, platform security, and OdinLink's own operations, OdinLink may determine the relevant processing purposes. If you are an end customer of an OdinLink business, that business's own privacy notice may also apply.</p>
    </section>

    <section>
      <h2>2. Data we may process</h2>
      <p>The data processed depends on how OdinLink is configured and which features and channels are used. It may include:</p>
      <ul>
        <li><strong>Business and account data:</strong> names, work contact details, workspace and user identifiers, account roles, business settings, service information, opening hours, and connected account details.</li>
        <li><strong>Connected-channel data:</strong> identifiers for Facebook Pages, Instagram accounts, Meta users or other connected business assets, along with channel usernames, display names, profile information made available by the channel, and connection status.</li>
        <li><strong>Messages and conversations:</strong> message text, timestamps, sender and recipient identifiers, delivery or interaction metadata, and media or attachments submitted through a connected channel when needed to handle the conversation.</li>
        <li><strong>Customer and booking data:</strong> a customer's name, phone number, email address where provided, requested service, preferred or confirmed date and time, booking status, and other information the customer or business includes in the booking conversation.</li>
        <li><strong>Connection credentials:</strong> OAuth tokens, access credentials, and related technical information required to connect and operate third-party channels and calendars. OdinLink is designed to encrypt stored channel credentials and restrict access to them.</li>
        <li><strong>Usage, analytics, and technical data:</strong> service events, feature usage, device or browser information, IP address and request metadata, error information, and security or diagnostic logs.</li>
      </ul>
      <p>OdinLink receives data from its business customers, their authorized users, people who contact those businesses, and connected providers such as Meta when an integration is authorized or a message is delivered.</p>
    </section>

    <section>
      <h2>3. Why data is processed</h2>
      <p>OdinLink may process personal data to:</p>
      <ul>
        <li>provide, maintain, and administer the service and customer accounts;</li>
        <li>connect authorized messaging channels and receive, understand, route, and send messages;</li>
        <li>support booking, rescheduling, cancellation, availability checks, reminders, and connected calendar workflows where enabled;</li>
        <li>show conversations, bookings, integration health, and operational analytics to authorized business users;</li>
        <li>secure accounts and integrations, prevent misuse, investigate incidents, and verify requests;</li>
        <li>monitor reliability, diagnose faults, provide support, and improve service performance; and</li>
        <li>comply with applicable law and enforce agreements.</li>
      </ul>
    </section>

    <section>
      <h2>4. GDPR legal grounds</h2>
      <p>Where the GDPR applies and OdinLink acts as a controller, processing may be based on performance of a contract, legitimate interests in operating and securing the service, compliance with legal obligations, or consent where consent is the appropriate basis. Legitimate interests are considered against the rights and interests of affected people. When OdinLink acts on behalf of a business customer, that business is responsible for identifying an appropriate legal basis and providing required notices for its processing.</p>
    </section>

    <section>
      <h2>5. How data is shared</h2>
      <p>OdinLink does not sell personal data. Data may be shared only as needed with:</p>
      <ul>
        <li>the business that controls the relevant OdinLink workspace and its authorized users;</li>
        <li>connected services, including Meta platforms and calendar providers, to receive or send information requested through the integration;</li>
        <li>service providers that support hosting, data storage, artificial-intelligence processing, analytics, security, troubleshooting, and other platform operations, subject to appropriate contractual and access restrictions;</li>
        <li>professional advisers, authorities, or other parties when reasonably necessary to comply with law, protect rights and safety, or address fraud or security incidents; and</li>
        <li>a successor involved in a merger, acquisition, financing, reorganization, or sale of relevant assets, subject to applicable confidentiality and data-protection requirements.</li>
      </ul>
      <p>Some providers may process data outside the European Economic Area. Any such processing is subject to applicable requirements for international transfers and data protection.</p>
    </section>

    <section>
      <h2>6. Retention</h2>
      <p>OdinLink retains personal data only for as long as reasonably necessary to provide the service, maintain security and business records, resolve disputes, and meet applicable legal obligations. The appropriate period depends on the type of data, the business customer's instructions and account status, the connected service, security needs, and legal requirements. Data that is no longer needed is deleted or anonymized in accordance with operational processes. Limited copies may remain temporarily in backups or where retention is required by law.</p>
    </section>

    <section>
      <h2>7. Security</h2>
      <p>OdinLink uses technical and organizational measures designed to protect personal data. These include access controls, separation of business workspaces, credential encryption, authenticated administrative access, request validation, logging, and monitoring. No online service can guarantee absolute security, and businesses should also protect their accounts, connected assets, and user access.</p>
    </section>

    <section>
      <h2>8. Your choices and rights</h2>
      <p>Depending on applicable law, individuals may have rights to request access, correction, deletion, restriction, or portability of personal data, or to object to certain processing. Where processing relies on consent, consent may be withdrawn without affecting earlier lawful processing. Individuals may also have the right to complain to their local data-protection authority.</p>
      <p>If your data was provided through a business using OdinLink, please contact that business first because it generally controls the conversation and booking data. OdinLink will assist its business customers with verified requests as required. Account holders and other individuals may contact <a href="mailto:admin.odinlink@gmail.com">admin.odinlink@gmail.com</a>. OdinLink may need to verify the request and may retain information where permitted or required by law.</p>
    </section>

    <section>
      <h2>9. Meta data deletion requests</h2>
      <p>Requests submitted through Facebook or Instagram's data-deletion or deauthorization mechanisms are verified, recorded, and matched to the relevant connected integration. OdinLink then handles the request in accordance with the business customer's instructions and applicable law. Deauthorization disables the matched connection. A deletion request may receive a confirmation code and status link through Meta's required flow.</p>
      <p>You may also request deletion of data associated with a Facebook or Instagram interaction by emailing <a href="mailto:admin.odinlink@gmail.com">admin.odinlink@gmail.com</a>. Include enough information to identify the relevant business and connected channel, but do not send passwords or access tokens. End customers may also contact the business they messaged. Deletion may be limited where data must be retained for legal, security, or dispute-resolution purposes.</p>
    </section>

    <section>
      <h2>10. Changes and contact</h2>
      <p>This policy may be updated as OdinLink and applicable requirements change. Material updates will be reflected by changing the date shown at the top of this page.</p>
      <p>Questions or privacy requests can be sent to <a href="mailto:admin.odinlink@gmail.com">admin.odinlink@gmail.com</a>.</p>
    </section>
  </>;
}

function TermsOfService() {
  return <>
    <section>
      <h2>1. Agreement and eligibility</h2>
      <p>These Terms of Service govern access to and use of OdinLink. By creating an account, connecting a channel, or using the service, you agree to these terms. If you use OdinLink for a company or other organization, you confirm that you are authorized to accept these terms for that organization. You must be legally able to enter into this agreement and provide accurate account information.</p>
    </section>

    <section>
      <h2>2. The service</h2>
      <p>OdinLink helps businesses manage customer conversations and automate parts of messaging, customer support, and appointment-booking workflows across connected channels. Features and available integrations may vary by plan, configuration, region, and third-party platform availability.</p>
      <p>You may use OdinLink only for your own authorized business purposes and in accordance with these terms, your agreement or order with OdinLink, and applicable law.</p>
    </section>

    <section>
      <h2>3. Connected accounts and Meta assets</h2>
      <p>You are responsible for every Facebook Page, Instagram account, Meta Business asset, calendar, or other third-party account you connect. You must have all permissions and authority required to connect and use those assets and to allow OdinLink to process the associated data.</p>
      <p>You are also responsible for complying with the terms, platform policies, messaging rules, consent requirements, and technical restrictions imposed by Meta and other connected providers. You must not connect an asset belonging to another person or organization without authorization, misrepresent your relationship to an asset, or attempt to bypass a provider's review or permission requirements.</p>
    </section>

    <section>
      <h2>4. Accounts and security</h2>
      <p>You are responsible for maintaining the confidentiality of login details, controlling access to your workspace, promptly removing access that is no longer authorized, and keeping connected accounts secure. Notify OdinLink promptly at <a href="mailto:admin.odinlink@gmail.com">admin.odinlink@gmail.com</a> if you suspect unauthorized access, credential compromise, or misuse. You remain responsible for activity performed through your account to the extent permitted by law.</p>
    </section>

    <section>
      <h2>5. Acceptable use</h2>
      <p>You must not use OdinLink to:</p>
      <ul>
        <li>break any law, regulation, court order, third-party right, or applicable platform policy;</li>
        <li>send spam, deceptive messages, unlawful marketing, harassment, threats, or abusive or discriminatory content;</li>
        <li>impersonate another person or business, or mislead people about whether they are interacting with automation;</li>
        <li>collect, disclose, or process personal data without an appropriate legal basis, notice, or authorization;</li>
        <li>upload malicious code, probe or disrupt the service, evade usage controls, or attempt unauthorized access;</li>
        <li>use the service to make high-impact decisions about individuals where automated use would be unlawful or inappropriate; or</li>
        <li>resell, copy, reverse engineer, or exploit the service except as expressly permitted by law or a written agreement with OdinLink.</li>
      </ul>
    </section>

    <section>
      <h2>6. Customer data and compliance</h2>
      <p>You retain responsibility for the content, instructions, business information, and customer data you provide or make available through OdinLink. You must ensure that your privacy notices, consents, records, response practices, and use of messaging and booking data comply with applicable law. Do not submit data that OdinLink has not agreed to process or that is unnecessary for the intended workflow.</p>
      <p>You grant OdinLink the limited rights needed to host, process, transmit, and display your data solely to operate, secure, support, and improve the service as described in the Privacy Policy and your agreement with OdinLink.</p>
    </section>

    <section>
      <h2>7. Automation and booking limitations</h2>
      <p>Automated messages, generated responses, availability results, and booking actions can be incomplete, delayed, or incorrect. They are tools to support your operations, not a substitute for appropriate human oversight. You are responsible for configuring business information and booking rules accurately, reviewing important conversations and appointments, and providing a way for customers to obtain human help when appropriate.</p>
      <p>OdinLink does not guarantee that every message will be delivered, that every customer request will be understood, or that a proposed or requested appointment will be successfully created. A booking should be treated as confirmed only when the relevant workflow and connected systems show confirmation.</p>
    </section>

    <section>
      <h2>8. Third-party services</h2>
      <p>OdinLink depends on third-party platforms and services, including messaging networks, Meta products, calendar services, hosting providers, and artificial-intelligence providers. Their terms and privacy practices apply to your use of their services. OdinLink does not control their availability, approvals, permissions, policy changes, rate limits, or decisions to restrict an account or integration, and is not responsible for third-party services to the extent permitted by law.</p>
    </section>

    <section>
      <h2>9. Availability and changes</h2>
      <p>OdinLink aims to provide a reliable service, but uninterrupted or error-free operation is not guaranteed. Maintenance, security events, provider outages, network failures, and other circumstances may affect availability. Features may be added, changed, suspended, or discontinued when reasonably necessary for security, compliance, provider requirements, or product development. Where practical, OdinLink will give reasonable notice of a material change that significantly reduces core paid functionality.</p>
    </section>

    <section>
      <h2>10. Intellectual property</h2>
      <p>OdinLink and its licensors retain all rights in the service, software, interface, documentation, branding, and related technology. These terms give you a limited, non-exclusive, non-transferable right to use the service during your authorized subscription or service period. They do not transfer ownership of OdinLink technology to you. You retain ownership of your own content and data, subject to the limited operational rights described above.</p>
    </section>

    <section>
      <h2>11. Suspension and termination</h2>
      <p>You may stop using the service and request account closure subject to any separate commercial agreement. OdinLink may restrict or suspend access where reasonably necessary to address a security risk, unlawful or abusive use, non-payment, a material breach, or a third-party platform requirement. When reasonable in the circumstances, OdinLink will provide notice and an opportunity to remedy the issue. Access may be terminated for an uncured material breach or where continued service would be unlawful or create material risk.</p>
      <p>After termination, access to the service may end and data will be handled in accordance with the Privacy Policy, applicable law, and any agreed data-return or deletion terms. Provisions that by their nature should continue will survive termination.</p>
    </section>

    <section>
      <h2>12. Disclaimers and liability</h2>
      <p>To the extent permitted by applicable law, the service is provided on an “as available” basis. OdinLink does not make warranties beyond those expressly stated in a written agreement. Nothing in these terms excludes warranties or rights that cannot lawfully be excluded.</p>
      <p>To the extent permitted by applicable law, OdinLink is not responsible for indirect or consequential loss, lost profits, lost business, or loss caused by third-party platforms, customer configuration, unauthorized account use, or reliance on unreviewed automated output. Any limitation agreed between OdinLink and a customer is subject to mandatory law and does not apply where liability cannot legally be limited. These terms do not limit responsibility for fraud, wilful misconduct, or any other liability that applicable law does not allow to be limited.</p>
    </section>

    <section>
      <h2>13. Privacy</h2>
      <p>The <a href="/privacy">OdinLink Privacy Policy</a> explains how personal data is handled. By using the service, you acknowledge that data will be processed as described there and in any applicable data-processing terms.</p>
    </section>

    <section>
      <h2>14. Changes to these terms</h2>
      <p>OdinLink may update these terms to reflect changes to the service, law, security requirements, or third-party platform rules. The last-updated date will be changed when revisions are published. Where required by law or reasonably appropriate for a material change, additional notice will be provided. Continued use after an update takes effect constitutes acceptance to the extent permitted by law.</p>
    </section>

    <section>
      <h2>15. Contact</h2>
      <p>Questions about these terms may be sent to <a href="mailto:admin.odinlink@gmail.com">admin.odinlink@gmail.com</a>.</p>
    </section>
  </>;
}

export default function LegalPage({ document }: { document: LegalDocument }) {
  const isPrivacy = document === 'privacy';
  const title = isPrivacy ? 'Privacy Policy' : 'Terms of Service';

  useEffect(() => {
    const previousTitle = window.document.title;
    const root = window.document.documentElement;
    const previousLang = root.lang;
    const previousDir = root.dir;
    window.document.title = `${title} | OdinLink`;
    root.lang = 'en';
    root.dir = 'ltr';
    window.scrollTo({ top: 0 });
    return () => {
      window.document.title = previousTitle;
      root.lang = previousLang;
      root.dir = previousDir;
    };
  }, [title]);

  return (
    <main className="legal-page">
      <header className="legal-header">
        <a className="legal-brand" href="/" aria-label="OdinLink home">
          <BrandMark />
          <span>OdinLink</span>
        </a>
        <a className="legal-back" href="/">Back to OdinLink</a>
      </header>

      <article className="legal-document">
        <div className="legal-intro">
          <p className="legal-kicker">Legal</p>
          <h1>{title}</h1>
          <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
        </div>

        <div className="legal-content">
          {isPrivacy ? <PrivacyPolicy /> : <TermsOfService />}
        </div>

        <nav className="legal-related" aria-label="Legal pages">
          <span>{isPrivacy ? 'Also read our' : 'See how we handle data in our'}</span>
          <a href={isPrivacy ? '/terms' : '/privacy'}>{isPrivacy ? 'Terms of Service' : 'Privacy Policy'}</a>
        </nav>
      </article>

      <footer className="legal-footer">
        <span>© 2026 OdinLink</span>
        <a href="mailto:admin.odinlink@gmail.com">admin.odinlink@gmail.com</a>
      </footer>
    </main>
  );
}
