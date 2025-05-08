const { z } = require("zod");
const { default: Instructor } = require("@instructor-ai/instructor");

// Define the classification label enum
const CLASSIFICATION_LABELS = {
  "NEEDS_DISCLAIMER": "NEEDS_DISCLAIMER",
  "NO_DISCLAIMER_NEEDED": "NO_DISCLAIMER_NEEDED"
};

// Define schema for classifier
const DisclaimerClassificationSchema = z.object({
  class_label: z.enum([CLASSIFICATION_LABELS.NEEDS_DISCLAIMER, CLASSIFICATION_LABELS.NO_DISCLAIMER_NEEDED]),
  explanation: z.string().describe("Explanation for why the message needs a disclaimer or not")
});

// Function to classify text using OpenAI
async function classifyTextForDisclaimer(openaiClient, text) {
  try {
    // Create an instructor client according to npm documentation
    const instructor = Instructor({
      client: openaiClient,
      mode: "TOOLS"
    });
    
    // Define the prompt for classification
    const prompt = `
    Analyze the following tax assistant response and determine if it needs a tax disclaimer.
    
    Apply these rules:
    1. If the response contains specific tax advice, calculations, or references to tax laws/codes, it NEEDS_DISCLAIMER
    2. If the response interprets tax regulations or suggests specific actions related to taxes, it NEEDS_DISCLAIMER
    3. If the response provides numbers, percentages, or dollar amounts related to taxes, it NEEDS_DISCLAIMER
    4. If the response recommends filing methods or specific forms, it NEEDS_DISCLAIMER
    5. If the response references or cites information from the U.S. Tax Code, it NEEDS_DISCLAIMER
    6. If the response provides factual information that would typically be sourced from the internet (such as statistics, dates, rates, or formal definitions), it NEEDS_DISCLAIMER
    7. If the response discusses economic policies, market trends, or business regulations, even if not directly tax-related, it NEEDS_DISCLAIMER
    8. If the response is general conversation, greetings, or clarification questions without factual content, it does NOT need a disclaimer
    
    Response to analyze:
    ${text}
    `;
    
    // Run the classification with the model
    const result = await instructor.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "gpt-4.1-mini",
      response_model: {
        schema: DisclaimerClassificationSchema,
        name: "DisclaimerClassification"
      },
      max_retries: 2
    });
    
    return result;
  } catch (error) {
    console.error("Error classifying text for disclaimer: ", error);
    // Default to REQUIRING a disclaimer if classification fails (fail-safe approach)
    return {
      class_label: CLASSIFICATION_LABELS.NEEDS_DISCLAIMER,
      explanation: "Classification failed, defaulting to showing disclaimer for safety"
    };
  }
}

module.exports = {
  classifyTextForDisclaimer,
  CLASSIFICATION_LABELS
};