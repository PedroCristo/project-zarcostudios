async function generateCloudinarySignature(
  params: Record<string, string>,
  apiSecret: string
): Promise<string> {
  const sortedKeys = Object.keys(params).sort();

  const signatureString =
    sortedKeys.map((k) => `${k}=${params[k]}`).join("&") + apiSecret;

  const msgUint8 = new TextEncoder().encode(signatureString);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost(context: any) {
  const env = context.env || {};

  const DEBUG = false; // 👈 toggle this only when needed

  try {
    const formData = await context.request.formData();
    const file = formData.get("file");
    const folder = (formData.get("folder") || "zarco-studio") as string;

    if (!(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: "Invalid or missing file" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const cloudName =
      env.CLOUDINARY_CLOUD_NAME || env.VITE_CLOUDINARY_CLOUD_NAME;
    const apiKey =
      env.CLOUDINARY_API_KEY || env.VITE_CLOUDINARY_API_KEY;
    const apiSecret =
      env.CLOUDINARY_API_SECRET || env.VITE_CLOUDINARY_API_SECRET;

    if (DEBUG) {
      console.log("CLOUDINARY ENV CHECK:", {
        cloudName,
        apiKeyExists: !!apiKey,
        apiSecretExists: !!apiSecret,
      });
    }

    if (!cloudName || !apiKey || !apiSecret) {
      return new Response(
        JSON.stringify({
          error: "Missing Cloudinary configuration",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const timestamp = String(Math.floor(Date.now() / 1000));

    const signature = await generateCloudinarySignature(
      { folder, timestamp },
      apiSecret
    );

    const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

    const cloudinaryForm = new FormData();
    cloudinaryForm.append("file", file);
    cloudinaryForm.append("folder", folder);
    cloudinaryForm.append("timestamp", timestamp);
    cloudinaryForm.append("api_key", apiKey);
    cloudinaryForm.append("signature", signature);

    if (DEBUG) {
      console.log("CLOUDINARY REQUEST:", {
        url: cloudinaryUrl,
        folder,
        timestamp,
      });
    }

    const res = await fetch(cloudinaryUrl, {
      method: "POST",
      body: cloudinaryForm,
    });

    const responseText = await res.text();

    if (DEBUG) {
      console.log("CLOUDINARY RESPONSE:", {
        status: res.status,
        body: responseText,
      });
    }

    if (!res.ok) {
      return new Response(
        JSON.stringify({
          error: "Cloudinary upload failed",
          status: res.status,
          detail: responseText,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    let uploadResponse;
    try {
      uploadResponse = JSON.parse(responseText);
    } catch {
      return new Response(
        JSON.stringify({
          error: "Invalid Cloudinary response",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({ url: uploadResponse.secure_url }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("UPLOAD ERROR:", {
      message: error?.message,
      stack: error?.stack,
    });

    return new Response(
      JSON.stringify({
        error: "Internal upload error",
        detail: error?.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}