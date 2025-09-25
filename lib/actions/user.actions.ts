'use server'

import { ID, Query } from "node-appwrite";
import { createAdminClient, createSessionClient } from "../appwrite";
import { cookies } from "next/headers";
import { encryptId, extractCustomerIdFromUrl, parseStringify } from "../utils";
import { CountryCode, ProcessorTokenCreateRequest, ProcessorTokenCreateRequestProcessorEnum, Products } from "plaid";
import { plaidClient } from "../plaid";  // "@/lib/plaid"
import { revalidatePath } from "next/cache";
import { addFundingSource, createDwollaCustomer } from "./dwolla.actions";

const {
   APPWRITE_DATABASE_ID: DATABASE_ID,
   APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
   APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

 
export const getUserInfo = async ({ userId }: getUserInfoProps) => {
 try {
  const {database} = await createAdminClient();

  const user = await database.listDocuments(
    DATABASE_ID!,
    USER_COLLECTION_ID!,
    [Query.equal('userId',[userId])]
  )
  return parseStringify(user.documents[0]);
 } catch (error) {
  console.log(error)
 }
}

export const signIn = async ({ email, password }: signInProps) => {
  try {
    const { account } = await createAdminClient();
    const session = await account.createEmailPasswordSession(email, password);

    (await cookies()).set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });

    const user = await getUserInfo({userId:session.userId})

    return parseStringify(user);
  } catch (error) {
    console.error('Error', error);
  }
}




export const signUp = async ({password, ...userData}:SignUpParams) => {
    const {firstName, lastName, email} = userData;

    let newUserAccount;
    try {
        const { account, database } = await createAdminClient();

          newUserAccount=  await account.create(
            ID.unique(),
               email,
               password,
               `${firstName} ${lastName}`
            ) ;

            if (!newUserAccount) throw new Error('Error creating user ');
            const dwollaCustomerUrl = await createDwollaCustomer({
              ...userData,
              type:'personal',
            })
            if(!dwollaCustomerUrl) throw new Error('Error creating dwolla customer');

            const dwollaCustomerId = extractCustomerIdFromUrl(dwollaCustomerUrl);

            let newuser: any = null;
            try {
              newuser = await database.createDocument(
                DATABASE_ID!,
                USER_COLLECTION_ID!,
                ID.unique(),
                {
                  ...userData,
                  userId: newUserAccount.$id,
                  dwollaCustomerId,
                  dwollaCustomerUrl,
                }
              );
            } catch (docError) {
              console.error('Failed to create Appwrite user document:', docError);
            }

       // Try to create a session and set cookie, but ensure we still return the user
       try {
         const session = await account.createEmailPasswordSession(
            email,
            password
         );
         // Some Appwrite SDK versions may not expose `secret`; guard it
         const sessionSecret = (session as any)?.secret;
         if (sessionSecret) {
           (await cookies()).set("appwrite-session", sessionSecret, {
             path: "/",
             httpOnly: true,
             sameSite: "strict",
             secure: true,
           });
         }
       } catch (sessionError) {
         console.error('Failed to create or persist Appwrite session after signup:', sessionError);
       }

       // Return the created document if available; otherwise a fallback user-like object
       if (newuser) {
         return parseStringify(newuser);
       }
       return parseStringify({
         $id: newUserAccount.$id,
         firstName,
         lastName,
         email,
         userId: newUserAccount.$id,
         dwollaCustomerId,
         dwollaCustomerUrl,
       });

    } catch (error) {
        console.error('signUp failed:', error);
        return null;
    }
}





export async function getLoggedInUser() {
  try {
    const { account } = await createSessionClient();
    const result = await account.get();

    const user = await getUserInfo({ userId: result.$id})

    return parseStringify(user);
  } catch (error) {
    console.log(error)
    return null;
  }
}


export const logoutAccount = async () => {
  try {
    const {account} = await createSessionClient();
    (await cookies()).delete("appwrite-session");
    await account.deleteSession('current');
  } catch (error) {
    return null;
  }
}


export const createLinkToken = async (user:User) =>{
try {
  const tokenParams = {
	user: {
		client_user_id: user.$id,
	},
	client_name: `${user.firstName} ${user.lastName}`,
	products: ["auth", "identity", "transactions"] as Products[],// Add "transactions" to the products array
	language: "en",
	country_codes: ["US", "ES"] as CountryCode[],
	update: { reauthorization_enabled: true }, // Enable reauthorization
};
  const response = await plaidClient.linkTokenCreate(tokenParams);
  return parseStringify({linkToken:response.data.link_token});
} catch (error) {
  console.log(error);
}
}




export const createBankAccount = async ({userId,bankId,accountId,accessToken,fundingSourceUrl,sharableId}:createBankAccountProps) =>{
try {
  const {database} = await createAdminClient();

  const bankAccount = await database.createDocument(
    DATABASE_ID!,
    BANK_COLLECTION_ID!,
    ID.unique(),
    {userId, bankId, accountId, accessToken, fundingSourceUrl, sharableId}
  );

  return parseStringify(bankAccount);
} catch (error) {
  
}
}





export const exchangePublicToken = async ({publicToken,user,}:exchangePublicTokenProps) =>{
   try {
    // Exchange a public token for an access token and item ID
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    // Get account information from plaid using  the access token
    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountData = accountsResponse.data.accounts[0];



    // Create aa processor token for dwolla using the access token and account ID 

    const request: ProcessorTokenCreateRequest = {
      access_token: accessToken,
      account_id: accountData.account_id,
      processor: 'dwolla' as ProcessorTokenCreateRequestProcessorEnum,
    };

    const processorTokenResponse = await plaidClient.processorTokenCreate(request);
    const processorToken = processorTokenResponse.data.processor_token;

    // Create a funding URL for the account using the dwolla customer ID, processor token and bank name

    const fundingSourceUrl = await addFundingSource({
      dwollaCustomerId: user.dwollaCustomerId,
      processorToken,
      bankName: accountData.name,
    });

    // if the funding source URL is not created , throw an error 

    if(!fundingSourceUrl) throw Error; 

     
    await createBankAccount({
      userId: user.$id,
      bankId: itemId,
      accountId: accountData.account_id,
      accessToken,
      fundingSourceUrl,
      sharableId:encryptId(accountData.account_id),
    });

    revalidatePath('/');

    return parseStringify({
      publicTokenExchange:"complete",
    })
    
   } catch (error) {
    console.error("An error occurred while creating exchanging token:", error);
   }
}

export const getBanks = async ({ userId }: getBanksProps) => {
  try {
    const { database } = await createAdminClient();

    const banks = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('userId', [userId])]
    )

    return parseStringify(banks.documents);
  } catch (error) {
    console.log(error)
  }
}


export const getBank = async ({ documentId }: getBankProps) => {
  try {
    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('$id', [documentId])]
    )

    return parseStringify(bank.documents[0]);
  } catch (error) {
    console.log(error)
  }
}
// AJOUTEEEE
export const categorizeTransactions = async (
  transactions: Transaction[]
): Promise<Transaction[]> => {
  return transactions.map((transaction) => {
    const name = transaction.name.toLowerCase();

    if (name.includes("mcdonald") || name.includes("starbucks")) {
      transaction.category = "Food and Drink";
    } else if (name.includes("uber") || name.includes("united airlines")) {
      transaction.category = "Travel";
    } else if (name.includes("credit card") || name.includes("intrst pymnt")) {
      transaction.category = "Payment";
    } else {
      transaction.category = "Transfer"; // default/fallback
    }

    return transaction;
  });
};

export const getBankByAccountId = async ({ accountId }: getBankByAccountIdProps) => {
  try {
    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('accountId', [accountId])]
    )

    if(bank.total!== 1) return null;

    return parseStringify(bank.documents[0]);
  } catch (error) {
    console.log(error)
  }
}