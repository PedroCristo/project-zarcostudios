import Stripe from "stripe";
import { getDocument, setDocument, listDocuments } from "../../_lib/firestore-rest";
import { sendEmailViaFetch } from "../../_lib/resend-rest";

// Standard Stripe translation logic
export function translateStripeError(message: string, isPt: boolean): string {
  if (!isPt) return message;
  const msgLower = (message || "").toLowerCase();
  if (msgLower.includes("sending credit card numbers directly") || msgLower.includes("raw card data") || msgLower.includes("unsafe")) {
    return "O envio direto de dados do cartão de crédito para a API do Stripe não é considerado seguro de acordo com as normas PCI. Por favor, utilize os tokens de teste oficiais para fins de Sandbox ou ative o suporte a dados brutos no painel do Stripe.";
  }
  if (msgLower.includes("was declined") || msgLower.includes("declined")) {
    return "O seu cartão de crédito foi recusado.";
  }
  if (msgLower.includes("security code is incorrect") || msgLower.includes("cvc is incorrect") || msgLower.includes("cvc_incorrect")) {
    return "O código de segurança (CVC) do seu cartão está incorreto.";
  }
  if (msgLower.includes("expiration year is invalid") || msgLower.includes("invalid_expiry_year")) {
    return "O ano de validade do seu cartão de crédito é inválido.";
  }
  if (msgLower.includes("expiration month is invalid") || msgLower.includes("invalid_expiry_month")) {
    return "O mês de validade do seu cartão de crédito é inválido.";
  }
  if (msgLower.includes("card has expired") || msgLower.includes("expired_card")) {
    return "O seu cartão de crédito expirou.";
  }
  if (msgLower.includes("incorrect_number") || msgLower.includes("card number is incorrect")) {
    return "O número do cartão de crédito introduzido está incorreto.";
  }
  if (msgLower.includes("invalid_number") || msgLower.includes("card number is invalid")) {
    return "O número do cartão de crédito introduzido é inválido.";
  }
  if (msgLower.includes("insufficient_funds") || msgLower.includes("insufficient funds")) {
    return "Saldo insuficiente no cartão de crédito fornecido.";
  }
  if (msgLower.includes("processing_error") || msgLower.includes("processing your card")) {
    return "Ocorreu um erro ao processar o seu cartão de crédito. Por favor, tente novamente.";
  }
  return message;
}

export async function onRequestPost(context: any) {
  const env = context.env || {};
  try {
    const body = await context.request.json();
    let { 
      projectId, 
      clientEmail, 
      clientName, 
      projectName, 
      subscriptionTitle, 
      subscriptionPrice, 
      subscriptionInterval, 
      transactionId, 
      lang,
      action,
      sessionId
    } = body;

    console.log("[Server][confirm-payment] Incoming request body:", JSON.stringify({
      projectId, clientEmail, clientName, projectName, subscriptionTitle,
      subscriptionPrice, subscriptionInterval, transactionId, lang, action, sessionId
    }));

    if (!projectId) {
      console.warn("[Server][confirm-payment] Missing required parameter: projectId");
      return new Response(
        JSON.stringify({ error: "Missing required parameter: projectId" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    let isPt = lang === "pt";
    let paidAtStr = new Date().toISOString();
    
    // Generate unique sequential transaction/receipt ID format: ZAR-[year]-SUB-00001
    const year = new Date().getFullYear();
    let nextNum = 1;
    try {
      console.log("[Server][confirm-payment] Listing clientProjects to compute next sequential sub id...");
      const snapshot = await listDocuments("clientProjects");
      let maxNum = 0;
      snapshot.forEach((pData: any) => {
        const stripeSubId = pData?.stripeSubscriptionId;
        if (stripeSubId && typeof stripeSubId === "string" && stripeSubId.startsWith(`ZAR-${year}-SUB-`)) {
          const parts = stripeSubId.split("-");
          const lastPart = parts[parts.length - 1];
          const num = parseInt(lastPart, 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      });
      nextNum = maxNum + 1;
      console.log(`[Server][confirm-payment] Computed nextNum=${nextNum} (maxNum=${maxNum}, year=${year})`);
    } catch (err) {
      console.warn("Failed to generate unique sub id suffix:", err);
      nextNum = Math.floor(Math.random() * 1000) + 100;
      console.warn(`[Server][confirm-payment] Falling back to random nextNum=${nextNum}`);
    }
    const paddedNum = String(nextNum).padStart(5, '0');
    const customTransactionId = `ZAR-${year}-SUB-${paddedNum}`;
    let transactionIdToUse = customTransactionId;
    console.log(`[Server][confirm-payment] customTransactionId=${customTransactionId}`);

    const stripeKey = env.STRIPE_SECRET_KEY;
    console.log(`[Server][confirm-payment] STRIPE_SECRET_KEY present: ${!!stripeKey}`);

    // --- CASE 1: STRIPE CHECKOUT VERIFICATION ---
    if (action === "verify" && sessionId) {
      console.log("[Server][confirm-payment] Branch: CASE 1 - verify checkout session");
      if (!stripeKey) {
        console.error("[Server][confirm-payment] Stripe key missing while attempting to verify session", sessionId);
        return new Response(
          JSON.stringify({ error: "Stripe key is missing in this environment" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      
      console.log(`[Server] Verifying Stripe Session ID: ${sessionId}`);
      const stripe = new Stripe(stripeKey, {
        apiVersion: "2023-10-16" as any
      });
      
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(`[Server][confirm-payment] Retrieved session ${session.id}: payment_status=${session.payment_status}, status=${session.status}, subscription=${session.subscription}`);

      if (session.payment_status !== "paid" && session.status !== "complete") {
        console.warn(`[Server][confirm-payment] Session ${sessionId} not paid/complete. payment_status=${session.payment_status}, status=${session.status}`);
        return new Response(
          JSON.stringify({ error: "Checkout session is not paid or completed yet." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      
      const meta = session.metadata || {};
      clientEmail = meta.clientEmail || session.customer_details?.email || clientEmail || "";
      clientName = meta.clientName || session.customer_details?.name || clientName || "Valued Customer";
      projectName = meta.projectName || projectName || "";
      subscriptionTitle = meta.subscriptionTitle || subscriptionTitle || "";
      subscriptionPrice = Number(meta.subscriptionPrice || subscriptionPrice || 0);
      subscriptionInterval = meta.subscriptionInterval || subscriptionInterval || "monthly";
      isPt = meta.lang === "pt" || isPt;
      
      transactionIdToUse = typeof session.subscription === "string" ? session.subscription : (session.id || customTransactionId);
      console.log(`[Server][confirm-payment] Resolved from metadata: clientEmail=${clientEmail}, clientName=${clientName}, projectName=${projectName}, subscriptionTitle=${subscriptionTitle}, subscriptionPrice=${subscriptionPrice}, subscriptionInterval=${subscriptionInterval}, isPt=${isPt}, transactionIdToUse=${transactionIdToUse}`);

      // Update Database via REST API helper
      console.log(`[Server] Updating db subscription status for verified project ${projectId}`);
      try {
        await setDocument("clientProjects", projectId, {
          subscriptionPaid: true,
          subscriptionPaidAt: paidAtStr,
          stripeSubscriptionId: transactionIdToUse,
          subscriptionCancelled: false
        }, true); // merge = true
        console.log("[Server] Database write succeeded via REST API helper.");
      } catch (dbErr: any) {
        console.warn("[Server] Database write failed during verification:", dbErr.message);
      }
    } // --- CASE 2: LIVE STRIPE CHECKOUT SESSION INITIATION ---
    else if (stripeKey) {
      console.log("[Server][confirm-payment] Branch: CASE 2 - create live Stripe checkout session");
      try {
        console.log(`[Server] Creating secure Stripe Checkout Session for client: ${clientEmail}`);
        const stripe = new Stripe(stripeKey, {
          apiVersion: "2023-10-16" as any
        });
        
        const origin = body.origin || context.request.headers.get("origin") || "http://localhost:3000";
        console.log(`[Server][confirm-payment] Using origin=${origin}`);
        
        // Find or create customer
        let stripeCustomerId: string | undefined;
        try {
          console.log(`[Server][confirm-payment] Looking up existing Stripe customer for email=${clientEmail}`);
          const existingCustomers = await stripe.customers.list({ email: clientEmail, limit: 1 });
          if (existingCustomers.data && existingCustomers.data.length > 0) {
            stripeCustomerId = existingCustomers.data[0].id;
            console.log(`[Server][confirm-payment] Found existing customer id=${stripeCustomerId}`);
          } else {
            console.log("[Server][confirm-payment] No existing customer found, creating new one");
            const customerObj = await stripe.customers.create({
              email: clientEmail,
              name: clientName || "Valued Customer",
              metadata: {
                projectId: projectId
              }
            });
            stripeCustomerId = customerObj.id;
            console.log(`[Server][confirm-payment] Created new customer id=${stripeCustomerId}`);
          }
        } catch (custErr) {
          console.warn("[Server] Failed to handle customer lookup, continuing without customer ID:", custErr);
        }

        console.log(`[Server][confirm-payment] Creating checkout session: price=${subscriptionPrice}, interval=${subscriptionInterval}, customerId=${stripeCustomerId}`);
        const session = await stripe.checkout.sessions.create({
          customer: stripeCustomerId,
          customer_email: stripeCustomerId ? undefined : (clientEmail || undefined),
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "eur",
                product_data: {
                  name: `${projectName || "Project"} - ${subscriptionTitle || "Subscription"}`,
                  description: `Zarco Studios Dedicated Subscription for ${projectName || "Project"}`,
                },
                unit_amount: Math.round(Number(subscriptionPrice || 0) * 100),
                recurring: {
                  interval: subscriptionInterval === "yearly" ? "year" : "month",
                },
              },
              quantity: 1,
            }
          ],
          mode: "subscription",
          success_url: `${origin}/project-hub/${projectId}?checkout_status=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/project-hub/${projectId}?checkout_status=cancel`,
          metadata: {
            projectId,
            projectName: projectName || "N/A",
            clientEmail: clientEmail || "",
            clientName: clientName || "",
            subscriptionTitle: subscriptionTitle || "",
            subscriptionPrice: String(subscriptionPrice || 0),
            subscriptionInterval: subscriptionInterval || "monthly",
            customTransactionId: customTransactionId,
            lang: isPt ? "pt" : "en"
          }
        });

        console.log(`[Server][confirm-payment] Checkout session created: id=${session.id}, url=${session.url}`);

        return new Response(
          JSON.stringify({
            success: true,
            checkoutUrl: session.url,
            sessionId: session.id
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (stripeErr: any) {
        console.error("[Server] Stripe direct process error:", stripeErr);
        const translatedMsg = translateStripeError(stripeErr.message || "An error occurred with Stripe processing.", isPt);
        console.error(`[Server][confirm-payment] Translated Stripe error message: ${translatedMsg}`);
        return new Response(
          JSON.stringify({ 
            error: translatedMsg,
            detail: stripeErr.message 
          }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }
    } 
    // --- CASE 3: SANDBOX / DEVELOPMENT MOCK PAYMENTS ---
    else {
      console.log("[Server][confirm-payment] Branch: CASE 3 - sandbox/mock payment (no Stripe key configured)");
      console.log(`[Server] No STRIPE_SECRET_KEY found. Direct client-side billing Sandbox mock fallback activated.`);
      
      // Update Database via REST API helper
      console.log(`[Server] Updating db subscription status for project ${projectId}`);
      try {
        await setDocument("clientProjects", projectId, {
          subscriptionPaid: true,
          subscriptionPaidAt: paidAtStr,
          stripeSubscriptionId: transactionIdToUse,
          subscriptionCancelled: false
        }, true); // merge = true
        console.log("[Server] Database write succeeded via REST API helper.");
      } catch (dbErr: any) {
        console.warn("[Server] Database write failed:", dbErr.message);
      }
    }

    // Get logo from settings if possible, or use a placeholder
    let logoUrl = null;
    try {
      console.log("[Server][confirm-payment] Fetching company-legal settings for logoUrl...");
      const settingsDoc = await getDocument("settings", "company-legal");
      if (settingsDoc) {
        logoUrl = settingsDoc.logoUrl;
      }
      console.log(`[Server][confirm-payment] logoUrl resolved: ${logoUrl}`);
    } catch (settingsErr) {
      console.warn("Failed to fetch settings for logo in confirm-payment:", settingsErr);
    }

    // Calculate next payment date
    const paidDate = new Date(paidAtStr);
    if (subscriptionInterval === "yearly") {
      paidDate.setFullYear(paidDate.getFullYear() + 1);
    } else {
      paidDate.setMonth(paidDate.getMonth() + 1);
    }
    const formattedNextDate = paidDate.toLocaleDateString(isPt ? 'pt-PT' : 'en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    console.log(`[Server][confirm-payment] paidAtStr=${paidAtStr}, formattedNextDate=${formattedNextDate}`);

    // Calculate paid month name
    const monthEnglish = new Date().toLocaleString('en-US', { month: 'long' });
    const ptMonthMap: Record<string, string> = {
      "January": "Janeiro",
      "February": "Fevereiro",
      "March": "Março",
      "April": "Abril",
      "May": "Maio",
      "June": "Junho",
      "July": "Julho",
      "August": "Agosto",
      "September": "Setembro",
      "October": "Outubro",
      "November": "Novembro",
      "December": "Dezembro"
    };
    const monthPortuguese = ptMonthMap[monthEnglish] || monthEnglish;
    const displayCurrentMonth = isPt ? monthPortuguese : monthEnglish;

    // Email to customer
    const clientSubject = isPt 
      ? "Subscrição Ativada com Sucesso - Zarco Studios" 
      : "Subscription Activated Successfully - Zarco Studios";

    const clientTitle = isPt ? "A sua subscrição está ativa!" : "Your subscription is now active!";
    const clientIntro = isPt 
      ? `Olá ${clientName || "Cliente"},<br>Confirmamos com sucesso o pagamento da sua subscrição com a Zarco Studios. Obrigado pela confiança!`
      : `Hello ${clientName || "Valued Client"},<br>We have successfully processed your subscription payment with Zarco Studios. Thank you for your trust!`;

    const detailsHeader = isPt ? "Detalhes da Assinatura" : "Subscription Details";
    const projectLabel = isPt ? "Projeto" : "Project";
    const planLabel = isPt ? "Plano" : "Plan";
    const valueLabel = isPt ? "Valor" : "Rate";
    const cycleLabel = isPt ? "Frequência" : "Billing Cycle";
    const cycleValue = subscriptionInterval === "yearly" ? (isPt ? "Anual" : "Yearly") : (isPt ? "Mensal" : "Monthly");
    const transactionLabel = isPt ? "ID da Transação" : "Transaction ID";
    const nextDueLabel = isPt ? "Próximo Pagamento" : "Next Payment Due";
    const statusLabel = isPt ? "Estado" : "Status";
    const activeText = isPt ? "Ativo" : "Active";
    const paidMonthLabel = isPt ? "Mês Pago" : "Paid Month";
    const thankYouFooter = isPt 
      ? "Caso tenha alguma dúvida, entre em contacto direto através do e-mail info@zarcostudios.com"
      : "If you have any questions, please contact directly via email info@zarcostudios.com";

    const clientHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111; line-height: 1.6;">
        ${logoUrl ? `<div style="text-align: left; margin-bottom: 30px;"><img src="${logoUrl}" alt="Logo" style="max-height: 146px;"></div>` : `
        <div style="text-align: left; margin-bottom: 30px; font-size: 20px; font-weight: bold; text-transform: uppercase; color: #22d3ee; letter-spacing: 2px;">
          ZARCO STUDIOS
        </div>`}
        <div style="background-color: #0c1417; color: #fff; padding: 40px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.05);">
          <h2 style="color: #22d3ee; text-transform: uppercase; letter-spacing: 1px; margin-top: 0; font-size: 20px; font-weight: 900;">${clientTitle}</h2>
          <p style="font-size: 14px; text-transform: none; color: rgba(255,255,255,0.8); line-height: 1.6; margin-bottom: 25px;">${clientIntro}</p>
          
          <div style="background-color: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 25px; border-radius: 16px; margin-bottom: 25px;">
            <h3 style="color: rgba(255,255,255,0.4); text-transform: uppercase; font-size: 11px; font-weight: 900; letter-spacing: 1.5px; margin-top: 0; margin-bottom: 15px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px;">${detailsHeader}</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px; width: 140px;">${projectLabel}</td>
                <td style="padding: 6px 0; color: #fff; font-weight: bold;">${projectName || "Zarco Project"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px;">${planLabel}</td>
                <td style="padding: 6px 0; color: #fff; font-weight: bold;">${subscriptionTitle || "Recurring Service"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px;">${valueLabel}</td>
                <td style="padding: 6px 0; color: #22d3ee; font-weight: 900;">€${Number(subscriptionPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px;">${cycleLabel}</td>
                <td style="padding: 6px 0; color: #fff;">${cycleValue}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px;">${paidMonthLabel}</td>
                <td style="padding: 6px 0; color: #22d3ee; font-weight: bold;">${displayCurrentMonth}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px;">${nextDueLabel}</td>
                <td style="padding: 6px 0; color: #4fd1dc; font-weight: bold;">${formattedNextDate}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px;">${transactionLabel}</td>
                <td style="padding: 6px 0; color: #fff; font-family: monospace;">${transactionIdToUse}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.4); font-weight: bold; text-transform: uppercase; font-size: 10px;">${statusLabel}</td>
                <td style="padding: 6px 0; color: #10b981; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">● ${activeText}</td>
              </tr>
            </table>
          </div>
          
          <p style="font-size: 12px; color: rgba(255,255,255,0.5); line-height: 1.6; margin: 0;">
            ${thankYouFooter}
          </p>
        </div>
        <div style="font-size: 11px; color: #999; text-align: center; margin-top: 30px;">
          <p>&copy; 2026 Zarco Studios. All rights reserved.</p>
        </div>
      </div>
    `;

    let clientEmailStatus = "not_sent";
    try {
      console.log(`[Server][confirm-payment] Sending confirmation email to clientEmail=${clientEmail}, subject="${clientSubject}"`);
      await sendEmailViaFetch(env, {
        from: 'Zarco Studios <no-reply@zarcostudios.com>',
        to: [clientEmail],
        subject: clientSubject,
        html: clientHtml,
      });
      clientEmailStatus = "sent";
      console.log("[Server][confirm-payment] Client email sent successfully on first attempt.");
    } catch (clientErr: any) {
      console.warn("[Server] Client email failed using custom domain. Retrying with no-reply@zarcostudios.com...", clientErr.message);
      try {
        await sendEmailViaFetch(env, {
          from: 'Zarco Studios <no-reply@zarcostudios.com>',
          to: [clientEmail],
          subject: clientSubject,
          html: clientHtml,
        });
        clientEmailStatus = "sent";
        console.log("[Server][confirm-payment] Client email sent successfully on retry.");
      } catch (retryErr: any) {
        console.error("[Server] Client email failed completely:", retryErr);
        clientEmailStatus = `failed: ${retryErr.message}`;
      }
    }

    console.log(`[Server][confirm-payment] Final result: transactionId=${transactionIdToUse}, clientEmailStatus=${clientEmailStatus}, paidAt=${paidAtStr}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Payment processed, DB synchronized, and client email processed.",
        paidAt: paidAtStr,
        transactionId: transactionIdToUse,
        clientEmailStatus,
        adminEmailStatus: "skipped_by_user_request"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("[Server] Error confirming payment:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Failed to confirm payment" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}