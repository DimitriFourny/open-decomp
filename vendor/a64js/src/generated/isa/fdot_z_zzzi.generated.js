export const ENCODINGS = [
    {
        "instructionId": "fdot_z_zzzi",
        "encodingId": "fdot_z_zzzi_",
        "mnemonic": "FDOT",
        "className": "SVE2",
        "fileName": "fdot_z_zzzi.xml",
        "mask": 4292934656,
        "value": 1679835136,
        "bitCount": 17,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "i2",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "opc2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sdot-z-zzz"
    }
];
