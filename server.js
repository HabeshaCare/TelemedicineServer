const fs = require("fs");
// const https = require("https");
const http = require("http");
const express = require("express");
const app = express();
const socketio = require("socket.io");
const jwt = require("socketio-jwt");

require("dotenv").config();

const isProduction = process.env.IS_PRODUCTION === "true";
const frontendUrl = process.env.FRONTEND_URL;
const backendUrl = process.env.DOTNET_URL;
const corsOrigin =
  isProduction && frontendUrl ? frontendUrl : "http://localhost:3000";

const UPDATE_INTERVAL_IN_MILLISECONDS = 1000;

//we need a key and cert to run https
//we generated them with mkcert
// $ mkcert create-ca
// $ mkcert create-cert
// const key = fs.readFileSync("cert.key");
// const cert = fs.readFileSync("cert.crt");

//we changed our express setup so we can use https
//pass the key and cert to createServer on https

// const expressServer = https.createServer({ key, cert }, app);

const expressServer = http.createServer(app);
//create our socket.io server... it will listen to our express port
const io = socketio(expressServer, {
  cors: {
    origin: [
      corsOrigin, //if using a phone or another computer
    ],
    methods: ["GET", "POST"],
  },
});

io.use(
  jwt.authorize({
    secret: process.env.SECRET_KEY,
    handshake: true,
  })
);
expressServer.listen(8181, () =>
  console.log("Server running on port 8181: Allowing CORS: ", frontendUrl)
);

//offers will contain {}
const offers = [
  // offererUserName
  // offer
  // offerIceCandidates
  // answererUserName
  // answer
  // answererIceCandidates
];
const connectedSockets = [
  //socketId
  //username
  //role
  //intervalId
  //connectedTime
  //remainingTime
  //connectionId
  //TODO: Make sure to add patient and doctors as a data here
];

io.on("connection", (socket) => {
  console.log("Found jwt token: ", socket.decoded_token);
  const email = socket.decoded_token.email;
  const role = socket.decoded_token.role;
  const connectionId = socket.handshake.query.connectionId;

  const { userAlreadyConnected, offerObj } = connectedUserOffer(connectionId);
  const didIOffer = userAlreadyConnected == null ? true : false; // If there is an already connected user, then the current user is the answerer

  connectedSockets.push({
    socketId: socket.id,
    email,
    role: role,
    intervalId: null,
    connectedTime: 0,
    remainingTime: null,
    connectionId,
  });

  console.log("User with name: ", email);
  socket.emit("connected", { didIOffer, offerObj });

  socket.on("sessionStarted", (timeToConnect) => {
    const email = socket.decoded_token.email;
    console.log("Session started for user: ", email);
    console.log("Received time to connect: ", timeToConnect);

    const connectedUsername = connectedTo(email);

    console.log("Connected to: ", connectedUsername);
    const answeringUser = connectedSockets.find((user) => user.email === email);
    const callingUser = connectedSockets.find(
      (user) => user.email === connectedUsername
    );

    console.log("Answering user info: ", answeringUser);
    console.log("Calling user info: ", callingUser);

    socket.to(answeringUser.socketId).emit("notification", "Session started");

    const intervalId = setInterval(() => {
      const userSessionsToUpdate = [answeringUser, callingUser];
      console.log("Interval running...");
      if (answeringUser && callingUser) {
        // console.log("User sessions to update: ", userSessionsToUpdate);
        userSessionsToUpdate.forEach((user) => {
          user.connectedTime += UPDATE_INTERVAL_IN_MILLISECONDS;

          if (user.role === "Patient") {
            if (!user.remainingTime) user.remainingTime = timeToConnect;
            user.remainingTime -= UPDATE_INTERVAL_IN_MILLISECONDS;
            console.log(
              "Updating Patient remaining time: ",
              user.remainingTime
            );

            if (user.remainingTime == 10 * 60 * 1000) {
              // Notify user at 10 minutes
              io.to(answeringUser.socketId).emit("notification", {
                title: "Warning! Connection Limit Reached",
                description: "Only 10 mins remaining",
              });
              io.to(callingUser.socketId).emit("notification", {
                title: "Warning! Connection Limit Reached",
                description: "Only 10 mins remaining",
              });
            }

            if (user.remainingTime <= 0) {
              io.to(answeringUser.socketId).emit("notification", {
                title: "Disconnected",
                description: "Session ended due to time limit!",
              });
              io.to(callingUser.socketId).emit("notification", {
                title: "Disconnected",
                description: "Session ended due to time limit!",
              });

              io.to(answeringUser.socketId).emit("sessionEnded", {
                title: "Disconnected",
                description: "Session ended due to time limit!",
              });
              io.to(callingUser.socketId).emit("sessionEnded", {
                title: "Diconnected",
                description: "Session ended due to time limit!",
              });

              console.log("Disconnecting user due to time limit exceeded");
            }
          }
        });
      }
    }, UPDATE_INTERVAL_IN_MILLISECONDS);

    answeringUser.intervalId = intervalId;
    callingUser.intervalId = intervalId;
  });
  //a new client has joined. If there are any offers available,
  //emit them out
  if (offers.length) {
    socket.emit("availableOffers", offers);
  }

  socket.on("newOffer", ({ newOffer, connectionId }) => {
    offers.push({
      offererUserName: email,
      offer: newOffer,
      offerIceCandidates: [],
      answererUserName: null,
      answer: null,
      answererIceCandidates: [],
    });
    // console.log(newOffer.sdp.slice(50))
    //send out to all connected sockets EXCEPT the caller

    socket.broadcast.emit("newOfferAwaiting", offers.slice(-1));
  });

  socket.on("newAnswer", (offerObj, ackFunction) => {
    // console.log(offerObj);
    //emit this answer (offerObj) back to CLIENT1
    //in order to do that, we need CLIENT1's socketid
    const socketToAnswer = connectedSockets.find(
      (s) => s.email === offerObj.offererUserName
    );
    if (!socketToAnswer) {
      console.log("No matching socket");
      return;
    }
    //we found the matching socket, so we can emit to it!
    const socketIdToAnswer = socketToAnswer.socketId;
    //we find the offer to update so we can emit it
    const offerToUpdate = offers.find(
      (o) => o.offererUserName === offerObj.offererUserName
    );
    if (!offerToUpdate) {
      console.log("No OfferToUpdate");
      return;
    }
    //send back to the answerer all the iceCandidates we have already collected
    ackFunction(offerToUpdate.offerIceCandidates);
    offerToUpdate.answer = offerObj.answer;
    offerToUpdate.answererUserName = email;
    //socket has a .to() which allows emitting to a "room"
    //every socket has it's own room
    socket.to(socketIdToAnswer).emit("answerResponse", offerToUpdate);
  });

  socket.on("sendIceCandidateToSignalingServer", (iceCandidateObj) => {
    const { didIOffer, iceCandidate } = iceCandidateObj;
    const iceUserName = socket.decoded_token.email;
    // console.log(iceCandidate);
    if (didIOffer) {
      //this ice is coming from the offerer. Send to the answerer
      const offerInOffers = offers.find(
        (o) => o.offererUserName === iceUserName
      );
      if (offerInOffers) {
        offerInOffers.offerIceCandidates.push(iceCandidate);
        // 1. When the answerer answers, all existing ice candidates are sent
        // 2. Any candidates that come in after the offer has been answered, will be passed through
        if (offerInOffers.answererUserName) {
          //pass it through to the other socket
          const socketToSendTo = connectedSockets.find(
            (s) => s.email === offerInOffers.answererUserName
          );
          if (socketToSendTo) {
            socket
              .to(socketToSendTo.socketId)
              .emit("receivedIceCandidateFromServer", iceCandidate);
          } else {
            console.log("Ice candidate received but could not find answer");
          }
        }
      }
    } else {
      //this ice is coming from the answerer. Send to the offerer
      //pass it through to the other socket
      const offerInOffers = offers.find(
        (o) => o.answererUserName === iceUserName
      );

      const socketToSendTo = connectedSockets.find(
        (s) => s.email === offerInOffers?.offererUserName
      );
      if (socketToSendTo) {
        socket
          .to(socketToSendTo.socketId)
          .emit("receivedIceCandidateFromServer", iceCandidate);
      } else {
        console.log("Ice candidate received but could not find offerer");
      }
    }
    // console.log(offers)
  });

  socket.on("disconnect", () => {
    console.log("disconnecting socket with id: ", socket.id);

    for (var i = 0; i < connectedSockets.length; i++) {
      var obj = connectedSockets[i];

      if (obj.socketId === socket.id) {
        //TODO: Here you need to make the necessary updates in the dotnet server too.
        // const axios = require("axios");

        const email = socket.decoded_token.email;
        const connectedUsername = connectedTo(email);
        console.log("Disconnecting email: ", email);
        const answeringUser = connectedSockets.find(
          (user) => user.email === email
        );
        const callingUser = connectedSockets.find(
          (user) => user.email === connectedUsername
        );

        const patient =
          callingUser?.role === "Patient" ? callingUser : answeringUser;
        const doctor =
          callingUser?.role === "Doctor" ? callingUser : answeringUser;

        // let updatePatient = axios.put(
        //   `${DOTNET_URL}/api/patient/${patient.email}/profile`,
        //   {
        //     currentBalance: patient.remainingTime, //TODO: Change this to be calculated with his hourly rate
        //   },
        //   {
        //     headers: {
        //       Authorization: `Bearer ${jwtToken}`,
        //       "Content-Type": "application/json",
        //     },
        //   }
        // );
        // let updateDoctor = axios.put(
        //   `${DOTNET_URL}/api/doctor/${doctor.email}/profile`,
        //   {
        //     availableMoney: doctor.connectedTime, //TODO: Change this to be calculated with his hourly rate
        //   }
        // );

        // Promise.all([updatePatient, updateDoctor])
        //   .then(function (responses) {
        //     // responses is an array of responses from all promises
        //     let patientResponse = responses[0];
        //     let doctorResponse = responses[1];

        //     console.log("Patient Response", patientResponse.data);
        //     console.log("Doctor Response", doctorResponse.data);
        //   })
        //   .catch(function (error) {
        //     console.log(error);
        //   });

        if (obj.intervalId) clearInterval(obj.intervalId); // Stopping the interval id
        let emailToDelete = obj.email;
        connectedSockets.splice(i, 1);
        for (var j = 0; j < offers.length; j++) {
          var offer = offers[j];
          if (
            offer.offererUserName === emailToDelete ||
            offer.answererUserName === emailToDelete
          ) {
            io.to(answeringUser?.socketId).emit("sessionEnded", {
              title: "Disconnected",
              description: `Session ended due to ${
                callingUser ? callingUser.email : "user"
              }'s disconnection!`,
            });
            io.to(callingUser?.socketId).emit("sessionEnded", {
              title: "Diconnected",
              description: `Session ended due to ${
                answeringUser ? answeringUser.email : "user"
              }'s disconnection!`,
            });
            offers.splice(j, 1);
            j--;
          }
        }
        i--;
      }
    }

    console.log("disconnected");
  });
});

const connectedTo = (email) => {
  //This function takes a email and returns the other email connected to it in WebRTC
  let offer = offers.find((o) => o.offererUserName === email);
  offer = offer ? offer : offers.find((o) => o.answererUserName === email);
  return offer?.offererUserName === email
    ? offer.answererUserName
    : offer?.offererUserName;
};

const connectedUserOffer = (connectionId) => {
  const userAlreadyConnected = connectedSockets.find(
    (user) => user.connectionId === connectionId
  );

  const offerObj = offers.find(
    (offer) => offer.offererUserName === userAlreadyConnected?.email
  );

  return { userAlreadyConnected, offerObj };
};
