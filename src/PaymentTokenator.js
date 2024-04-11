const Tokenator = require('@babbage/tokenator')
const BabbageSDK = require('@babbage/wrapped-sdk')
const { Ninja } = require('ninja-base')
const bsv = require('babbage-bsv')

const STANDARD_PAYMENT_MESSAGEBOX = 'payment_inbox'

/**
 * Extends the Tokenator class to enable peer-to-peer Bitcoin payments
 * @param {object} obj All parameters are given in an object.
 * @param {String} [obj.peerServHost] The PeerServ host you want to connect to.
 * @param {String} [obj.clientPrivateKey] A private key to use for mutual authentication with Authrite. (Optional - Defaults to Babbage signing strategy).
 */
class PaymentTokenator extends Tokenator {
  constructor({
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
  async createPaymentToken(payment) {
    const outputInfo = await this.getP2PKHOutputInfo({ recipient: payment.sender })

    // Create a new Bitcoin transaction
    const paymentAction = await BabbageSDK.createAction({
      description: 'Tokenator payment',
      outputs: [{ script: outputInfo.script, satoshis: payment.amount }]
    })

    // Configure the standard messageBox and payment body
    payment.messageBox = STANDARD_PAYMENT_MESSAGEBOX
    payment.body = {
      derivationPrefix: outputInfo.derivationPrefix,
      transaction: {
        ...paymentAction,
        outputs: [{ vout: 0, satoshis: payment.amount, derivationSuffix: outputInfo.derivationSuffix }]
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
  async sendPayment(payment) {
    const paymentToken = await this.createPaymentToken(payment)
    return await this.sendMessage(paymentToken)
  }

  /**
   * Sends Bitcoin to a PeerServ recipient over web sockets
   * @param {Object} payment The payment object
   * @param {string} payment.recipient The recipient of the payment
   * @param {Number} payment.amount The amount in satoshis to send
   */
  async sendLivePayment(payment) {
    const paymentToken = await this.createPaymentToken(payment)
    await this.sendLiveMessage(paymentToken)
  }

  /**
   * Listens for incoming Bitcoin payments over web sockets
   * @param {Object} obj
   */
  async listenForLivePayments({ onPayment, autoAcknowledge = true }) {
    await this.listenForLiveMessages({
      onMessage: onPayment,
      messageBox: STANDARD_PAYMENT_MESSAGEBOX,
      autoAcknowledge
    })
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
  async acceptPayment(payment) {
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

    // Receive payment using submitDirectTransaction
    try {
      // Note: custom acceptance validation could be added here.
      // Example: if (message.amount > 100000000) {...acceptance criteria}
      const paymentResult = await getLib().submitDirectTransaction({
        protocol: '3241645161d8',
        senderIdentityKey: payment.sender,
        note: 'PeerServ payment',
        amount: payment.amount,
        derivationPrefix: payment.token.derivationPrefix,
        transaction: payment.token.transaction
      })

      // Acknowledge the payment(s) has been received, if they haven't been already
      try {
        await this.acknowledgeMessage({ messageIds: [payment.messageId] })
      } catch (error) {
        // If the error is invalid acknowledgement, we can assume it has already been acknowledged.
        if (error.code !== 'ERR_INVALID_ACKNOWLEDGMENT') {
          throw error
        }
      }
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
   * Rejects an incoming payment
   * @param {Object} payment The payment object
   * @param {Number} payment.messageId The Id of the paymentMessage
   * @param {String} payment.sender The identityKey of the sender
   * @param {Number} payment.amount The amount of the payment
   * @param {Object} payment.token containing the P2PKH derivation instructions
   * @returns
   */
  async rejectPayment(payment) {
    // TODO: Figure out what the signing strategy should be
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

    // Reject payment using createAction
    try {
      // Create a new P2PKH output to send back to the sender
      const outputInfo = await this.getP2PKHOutputInfo({ recipient: payment.sender })
      const prevTx = new bsv.Transaction(payment.token.transaction.rawTx)
      const defaultVout = 0

      // Create a new TX to send back the incoming payment
      const outgoingTx = await BabbageSDK.createAction({
        inputs: {
          [payment.token.transaction.txid]: {
            ...payment.token.transaction,
            outputsToRedeem: [{
              index: defaultVout,
              unlockingScript: prevTx.outputs[defaultVout].script.toHex()
            }]
          }
        },
        outputs: [{
          script: outputInfo.script,
          satoshis: payment.token.amount
        }],
        description: 'Reject an incoming payment'
      })

      // Acknowledge the payment message has been received, if they haven't been already
      try {
        await this.acknowledgeMessage({ messageIds: [payment.messageId] })
      } catch (error) {
        // If the error is invalid acknowledgement, we can assume it has already been acknowledged.
        if (error.code !== 'ERR_INVALID_ACKNOWLEDGMENT') {
          throw error
        }
      }

      // Send outgoingTx back to sender
      // TODO: Validate the standard structure of a Tokenator payment (small discrepancies such as amount)
      return await this.sendMessage(payment.body = {
        derivationPrefix: outputInfo.derivationPrefix,
        transaction: {
          ...outgoingTx,
          outputs: [{ vout: 0, satoshis: payment.token.amount, derivationSuffix: outputInfo.derivationSuffix }]
        },
        amount: payment.token.amount
      })
    } catch (e) {
      console.log(`Error: ${e}`)
      return 'Unable to send back rejected payment!'
    }
  }

  /**
   * Lists incoming Bitcoin payments
   * @returns {Array} of payments to receive
   */
  async listIncomingPayments() {
    const messages = await this.listMessages({ messageBox: STANDARD_PAYMENT_MESSAGEBOX })
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

  /**
   * Helper function for deriving P2PKH payment info
   * @param {object} obj
   * @param {string} obj.recipient identity key of the recipient of the P2PKH payment
   * @returns
   */
  async getP2PKHOutputInfo({ recipient }) {
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
      counterparty: recipient
    })

    // Create a P2PK Bitcoin script
    const script = new bsv.Script(
      bsv.Script.fromAddress(bsv.Address.fromPublicKey(
        bsv.PublicKey.fromString(derivedPublicKey)
      ))
    ).toHex()

    return {
      derivationPrefix,
      derivationSuffix,
      derivedPublicKey,
      script
    }
  }
}
module.exports = PaymentTokenator
