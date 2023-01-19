const Tokenator = require('@babbage/tokenator')
const BabbageSDK = require('@babbage/sdk')
const Ninja = require('utxoninja')
const bsv = require('babbage-bsv')

const STANDARD_PAYMENT_MESSAGEBOX = 'payment_inbox'

/**
 * Extends the Tokenator class to enable peer-to-peer Bitcoin payments
 * @param {object} obj All parameters are given in an object.
 * @param {String} [obj.peerServHost] The PeerServ host you want to connect to.
 * @param {String} [obj.clientPrivateKey] A private key to use for mutual authentication with Authrite. (Optional - Defaults to Babbage signing strategy).
 */
class PaymentTokenator extends Tokenator {
  constructor ({
    peerServHost = 'https://staging-peerserv.babbage.systems',
    clientPrivateKey
  } = {}) {
    super({ peerServHost, clientPrivateKey })
  }

  /**
   * @param {Object} payment The payment object
   * @param {string} payment.recipient The recipient of the payment
   * @param {Number} payment.amount The amount in satoshis to send
   * @returns {Object} a valid payment token
   */
  async createPaymentToken (payment) {
    // Derive a new public key for the recipient according to the P2PKH Payment Protocol.
    const derivationPrefix = require('crypto')
      .randomBytes(10)
      .toString('base64')
    const derivationSuffix = require('crypto')
      .randomBytes(10)
      .toString('base64')
    const derivedPublicKey = await BabbageSDK.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: payment.recipient
    })

    // Create a P2PK Bitcoin script
    const script = new bsv.Script(
      bsv.Script.fromAddress(bsv.Address.fromPublicKey(
        bsv.PublicKey.fromString(derivedPublicKey)
      ))
    ).toHex()

    // Create a new Bitcoin transaction
    const paymentAction = await BabbageSDK.createAction({
      description: 'Tokenator payment',
      outputs: [{ script, satoshis: payment.amount }]
    })

    // Configure the standard messageBox and payment body
    payment.messageBox = STANDARD_PAYMENT_MESSAGEBOX
    payment.body = {
      derivationPrefix,
      transaction: {
        ...paymentAction,
        outputs: [{ vout: 0, satoshis: payment.amount, derivationSuffix }]
      },
      amount: payment.amount
    }
    return payment
  }

  /**
   * Sends Bitcoin to a PeerServ recipient
   * @param {Object} payment The payment object
   * @param {string} payment.recipient The recipient of the payment
   * @param {Number} payment.amount The amount in satoshis to send
   */
  async sendPayment (payment) {
    const paymentToken = await this.createPaymentToken(payment)
    return await this.sendMessage(paymentToken)
  }

  /**
   * Accepts a payment into the default basket
   * @param {Object} payment The payment object
   * @param {Number} payment.messageId The Id of the paymentMessage
   * @param {String} payment.sender The identityKey of the sender
   * @param {Number} payment.amount The amount of the payment
   * @param {Object} payment.token containing the P2PKH derivation instructions
   * @returns
   */
  async acceptPayment (payment) {
    // Figure out what the signing strategy should be
    const getLib = () => {
      if (!this.clientPrivateKey) {
        return BabbageSDK
      }
      const ninja = new Ninja({
        privateKey: this.clientPrivateKey,
        config: {
          dojoURL: 'https://staging-dojo.babbage.systems'
        }
      })
      return ninja
    }

    // Recieve payment using submitDirectTransaction
    try {
      // Note: custom acceptance validation could be added here.
      // Example: if (message.amount > 100000000) {...acceptance criteria}
      const paymentResult = await getLib().submitDirectTransaction({
        protocol: '3241645161d8',
        senderIdentityKey: payment.sender,
        note: 'PeerServ payment',
        amount: payment.amount,
        derivationPrefix: payment.token.derivationPrefix,
        transaction: payment.tokens.transaction
      })
      if (paymentResult.status !== 'success') {
        throw new Error('Payment not processed')
      }
      // Acknowledge the payment(s) has been recieved
      await this.acknowledgeMessage({ messageIds: [payment.messageId] })
      return {
        payment,
        paymentResult
      }
    } catch (e) {
      console.log(`Error: ${e}`)
      return 'Unable to receive payment!'
    }
  }

  /**
   * Lists incoming Bitcoin payments
   * @returns {Array} of payments to receive
   */
  async listIncomingPayments () {
    const messages = await this.listMessages({ messageBox: [STANDARD_PAYMENT_MESSAGEBOX] })
    const payments = messages.map(x => {
      return {
        messageId: x.messageId,
        sender: x.sender,
        amount: x.amount,
        token: JSON.parse(x.body)
      }
    })

    return payments
  }
}
module.exports = PaymentTokenator
