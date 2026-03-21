var express = require("express");
var router = express.Router();
let userController = require('../controllers/users')
let { RegisterValidator, validationResult, ChangPasswordValidator } = require('../utils/validatorHandler')
let { CheckLogin } = require('../utils/authHandler')
let jwt = require('jsonwebtoken')
let bcrypt = require('bcrypt')
let fs = require('fs')
let crypto = require('crypto')
let { sendMail } = require('../utils/mailHandler')
let mongoose = require('mongoose');
let cartSchema = require('../schemas/carts')



router.post('/register', RegisterValidator, validationResult, async function (req, res, next) {
    let session = await mongoose.startSession();
    session.startTransaction()
    try {
        let newItem = await userController.CreateAnUser(
            req.body.username, req.body.password, req.body.email,
            "69af870aaa71c433fa8dda8e", session
        )
        let newCart = new cartSchema({
            user: newItem._id
        })
        await newCart.save({ session });
        await newCart.populate('user');
        await session.commitTransaction()
        await session.endSession()
        res.send(newCart);

    } catch (err) {
        await session.abortTransaction()
        await session.endSession()
        res.status(400).send({ message: err.message });
    }
})
router.post('/login', async function (req, res, next) {
    try {
        let { username, password } = req.body;
        let result = await userController.FindUserByUsername(username);
        if (!result) {
            res.status(403).send("sai thong tin dang nhap");
            return;
        }
        if (result.lockTime > Date.now()) {
            res.status(404).send("ban dang bi ban");
            return;
        }
        result = await userController.CompareLogin(result, password);
        if (!result) {
            res.status(403).send("sai thong tin dang nhap");
            return;
        }
        let token = jwt.sign({
            id: result._id
        }, 'secretKey', {
            expiresIn: '1d'
        })
        res.cookie("LOGIN_NNPTUD_S3", token, {
            maxAge: 24 * 60 * 60 * 1000,
            httpOnly: true
        })
        res.send(token)

    } catch (err) {
        res.status(400).send({ message: err.message });
    }
})
router.get('/me', CheckLogin, function (req, res, next) {
    let user = req.user;
    res.send(user)
})
router.post('/logout', CheckLogin, function (req, res, next) {
    res.cookie("LOGIN_NNPTUD_S3", "", {
        maxAge: 0,
        httpOnly: true
    })
    res.send("da logout ")
})
router.post('/changepassword', CheckLogin,
    ChangPasswordValidator, validationResult
    , async function (req, res, next) {
        let { newpassword, oldpassword } = req.body;
        let user = req.user;
        if (bcrypt.compareSync(oldpassword, user.password)) {
            user.password = newpassword;
            await user.save();
            res.send("doi pass thanh cong")
        } else {
            res.status(404).send("old password khog dung")
        }
    })

router.post('/forgotpassword', async function (req, res, next) {
    let { email } = req.body;
    let user = await userController.FindUserByEmail(email);
    if (user) {
        user.forgotPasswordToken = crypto.randomBytes(32).toString('hex');
        user.forgotPasswordTokenExp = Date.now() + 10 * 60 * 1000;
        let url = "http://localhost:3000/api/v1/auth/resetpassword/" + user.forgotPasswordToken
        await user.save();
        await sendMail(user.email, url)
    }
    res.send("check email")
})
router.post('/resetpassword/:token', async function (req, res, next) {
    let { password } = req.body;
    let user = await userController.FindUserByToken(req.params.token);
    if (user) {
        user.password = password
        user.forgotPasswordToken = null;
        user.forgotPasswordTokenExp = null;
        await user.save();
        res.send("da cap nhat")
    } else {
        res.status(404).send("token loi")
    }

})
module.exports = router;